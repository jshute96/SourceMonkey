// Unit tests for src/harness/prepare.ts (compiled to lib/harness/prepare.js):
// the harness's front door, which runs the real install pipeline under
// Node over files on disk.
//
// Real files in a tmp directory rather than a seeded fetch cache — the
// point of the harness is the whole path from a path on disk to the
// registered entries, `file://` reads included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { explainMatch, prepareScript, withDefaultScheme } from '../../../lib/harness/prepare.js';
import { NO_NAME } from '../../../dist/extension/script-store.js';

const HEADER = `// ==UserScript==
// @name         Test script
// @match        https://example.com/items/*
// @exclude      https://example.com/items/private*
// @grant        GM_setValue
// ==/UserScript==
`;

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sm-harness-'));
  await mkdir(path.join(root, 'sites', 'example.com'), { recursive: true });
  await mkdir(path.join(root, 'lib'), { recursive: true });
  return {
    root,
    async write(relative, text) {
      const full = path.join(root, relative);
      await writeFile(full, text);
      return full;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('prepareScript: a valid script yields its id, matching and world', async () => {
  const r = await repo();
  try {
    const file = await r.write('sites/example.com/a.user.js', HEADER + 'console.log("hi");\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.status, 'ok');
    assert.equal(p.errorMessage, undefined);
    assert.equal(p.id, p.script.id);
    assert.equal(p.world, 'USER_SCRIPT');
    assert.deepEqual(p.matching.matches, ['https://example.com/items/*']);
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: @grant none lands in MAIN world', async () => {
  const r = await repo();
  try {
    const file = await r.write('sites/example.com/a.user.js',
      HEADER.replace('@grant        GM_setValue', '@grant        none') + '1;\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.world, 'MAIN');
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: an invalid header reports the extension\'s own message', async () => {
  const r = await repo();
  try {
    const file = await r.write('sites/example.com/a.user.js',
      HEADER.replace('// @name         Test script\n', '') + '1;\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.status, 'invalid');
    assert.equal(p.errorMessage, NO_NAME);
    assert.equal(p.id, undefined);
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: a syntax error names the file and line', async () => {
  const r = await repo();
  try {
    const file = await r.write('sites/example.com/a.user.js', HEADER + 'ok();\nlet = ;\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.status, 'invalid');
    assert.match(p.errorMessage, /^Syntax error: /);
    // Relative to the collection root, as the extension stores it.
    assert.equal(p.errorLocation.file, 'sites/example.com/a.user.js');
    // The header is six lines; `let = ;` is the second body line.
    assert.equal(p.errorLocation.line, 8);
    assert.match(p.diagnostic, /line 8/);
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: a GitHub @require reads the local lib/ copy under the repo root', async () => {
  const r = await repo();
  try {
    await r.write('lib/helper.js', 'function helper() { return 42; }\n');
    const file = await r.write('sites/example.com/a.user.js',
      HEADER.replace('// ==/UserScript==',
        '// @require      https://raw.githubusercontent.com/me/repo/main/lib/helper.js\n// ==/UserScript==')
      + 'helper();\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.status, 'ok', p.diagnostic);
    assert.equal(p.requires.length, 1);
    assert.equal(p.requires[0].localUrl, pathToFileURL(path.join(r.root, 'lib/helper.js')).toString());
    assert.match(p.script.requires[0].source, /function helper\(\)/);
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: a relative @require resolves beside the script', async () => {
  const r = await repo();
  try {
    await r.write('sites/example.com/shared.js', 'const SHARED = 1;\n');
    const file = await r.write('sites/example.com/a.user.js',
      HEADER.replace('// ==/UserScript==', '// @require      shared.js\n// ==/UserScript==')
      + 'SHARED;\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.status, 'ok', p.diagnostic);
    assert.match(p.script.requires[0].source, /const SHARED = 1/);
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: a missing @require is invalid, not silently dropped', async () => {
  const r = await repo();
  try {
    const file = await r.write('sites/example.com/a.user.js',
      HEADER.replace('// ==/UserScript==', '// @require      nope.js\n// ==/UserScript==')
      + '1;\n');
    const p = await prepareScript({ file, collectionRoot: r.root });
    assert.equal(p.status, 'invalid');
    assert.match(p.errorMessage, /^@require nope\.js: /);
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: two scripts sharing a basename get distinct ids', async () => {
  const r = await repo();
  try {
    await mkdir(path.join(r.root, 'sites', 'other.test'), { recursive: true });
    const a = await r.write('sites/example.com/a.user.js', HEADER + '1;\n');
    const b = await r.write('sites/other.test/a.user.js', HEADER + '2;\n');
    const [pa, pb] = await Promise.all([
      prepareScript({ file: a, collectionRoot: r.root }),
      prepareScript({ file: b, collectionRoot: r.root }),
    ]);
    assert.notEqual(pa.id, pb.id);
    assert.equal(pa.script.relativePath, 'sites/example.com/a.user.js');
    assert.equal(pb.script.relativePath, 'sites/other.test/a.user.js');
  } finally {
    await r.cleanup();
  }
});

test('prepareScript: text without a file works, with a placeholder location', async () => {
  const p = await prepareScript({ text: HEADER + '1;\n', collectionRoot: os.tmpdir() });
  assert.equal(p.status, 'ok');
});

test('explainMatch: names the rule that decided, and every rule that covers the URL', () => {
  const matching = {
    matches: ['https://example.com/items/*', 'https://example.com/*'],
    excludes: ['https://example.com/items/private*', '*/private/*'],
    includes: ['/^https:\\/\\/other\\.test\\//'],
  };
  assert.deepEqual(explainMatch(matching, 'https://example.com/items/42'), {
    matches: true,
    rule: '@match https://example.com/items/*',
    matchedBy: ['@match https://example.com/items/*', '@match https://example.com/*'],
    excludedBy: [],
  });
  // Excluded, but still naming the rules the excludes overrode.
  assert.deepEqual(explainMatch(matching, 'https://example.com/items/private/1'), {
    matches: false,
    rule: '@exclude https://example.com/items/private*',
    matchedBy: ['@match https://example.com/items/*', '@match https://example.com/*'],
    excludedBy: ['@exclude https://example.com/items/private*', '@exclude */private/*'],
  });
  assert.deepEqual(explainMatch(matching, 'https://other.test/x'), {
    matches: true,
    rule: '@include /^https:\\/\\/other\\.test\\//',
    matchedBy: ['@include /^https:\\/\\/other\\.test\\//'],
    excludedBy: [],
  });
  assert.deepEqual(explainMatch(matching, 'https://elsewhere.test/'),
    { matches: false, rule: null, matchedBy: [], excludedBy: [] });
});

test('withDefaultScheme reads an existing file, or a word not starting with a host, as a file', () => {
  // Run from the repo root, where these exist and `docs.example` doesn't.
  const here = (p) => pathToFileURL(path.resolve(p)).toString();
  assert.equal(withDefaultScheme('README.md'), here('README.md'));
  assert.equal(withDefaultScheme('tests/examples/index.html'), here('tests/examples/index.html'));
  assert.equal(withDefaultScheme('tests/no-such-page.html'), here('tests/no-such-page.html'));
  assert.equal(withDefaultScheme('docs.example/x'), 'http://docs.example/x');
  // No dot, no port, not localhost: a path, even one that doesn't exist.
  assert.equal(withDefaultScheme('nowhere/x'), here('nowhere/x'));
  assert.equal(withDefaultScheme('localhost/x'), 'http://localhost/x');
  assert.equal(withDefaultScheme('[::1]/x'), 'http://[::1]/x');
  // Starting with a dot: a path, though its first part has one.
  assert.equal(withDefaultScheme('.hidden.example/x'), here('.hidden.example/x'));
});

test('withDefaultScheme adds http:// only where a URL has no scheme', () => {
  assert.equal(withDefaultScheme('example.com/x'), 'http://example.com/x');
  assert.equal(withDefaultScheme('localhost:8080/x'), 'http://localhost:8080/x');
  assert.equal(withDefaultScheme('https://example.com/'), 'https://example.com/');
  assert.equal(withDefaultScheme('about:blank'), 'about:blank');
  assert.equal(withDefaultScheme('file:/tmp/x.html'), 'file:/tmp/x.html');
  // A path is a local file, not a host.
  assert.equal(withDefaultScheme('/tmp/x.html'), 'file:///tmp/x.html');
  assert.equal(withDefaultScheme('./x.html'), pathToFileURL(path.resolve('x.html')).toString());
});
