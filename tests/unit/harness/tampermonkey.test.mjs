// Unit tests for what sm-dev does to scripts it gives Tampermonkey
// (tampermonkey.ts): relative @require and @resource lines rewritten,
// and put back as they were; and the E-numbers it keeps for TM's uuids
// (tm-ids.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readMark, markedText } from '../../../lib/harness/script-mark.js';
import { restoredText, rewrittenText } from '../../../lib/harness/tampermonkey.js';
import { TmIds } from '../../../lib/harness/tm-ids.js';

const SCRIPT = [
  '// ==UserScript==',
  '// @name        x',
  '// @require     lib.js',
  '// @require     https://cdn.example/jq.js',
  '// @resource    css ./style.css',
  '// ==/UserScript==',
  '// @require     not-in-the-header.js',
  'run();',
  '',
].join('\n');

test('local dependencies are rewritten to where they resolve, and restored with the mark kept last', () => {
  const marked = markedText(SCRIPT, { run: 'D1', started: 's', file: '/home/me/x.user.js' });
  const text = rewrittenText(marked, 'https://sm-dev.invalid/home/me/x.user.js');
  const lines = text.split('\n');
  assert.equal(lines[2], '// @require     https://sm-dev.invalid/home/me/lib.js');
  assert.equal(lines[3], '// @require     https://cdn.example/jq.js');
  assert.equal(lines[4], '// @resource    css https://sm-dev.invalid/home/me/style.css');
  assert.equal(lines[6], '// @require     not-in-the-header.js');
  assert.deepEqual(readMark(text), { run: 'D1', started: 's', file: '/home/me/x.user.js' });
  assert.equal(restoredText(text), marked);
});

test('a script from a URL resolves against it, and one with nothing to rewrite is left as it is', () => {
  const text = rewrittenText(SCRIPT, 'https://example.com/s/x.user.js');
  assert.equal(text.split('\n')[2], '// @require     https://example.com/s/lib.js');
  assert.equal(restoredText(text), SCRIPT);
  const plain = '// ==UserScript==\n// @name x\n// ==/UserScript==\nrun();\n';
  assert.equal(rewrittenText(plain, 'https://sm-dev.invalid/x.user.js'), plain);
  assert.equal(restoredText(plain), plain);
});

test('E-numbers are kept per uuid, in a file, and new ones count on', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tm-ids-'));
  const was = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    const ids = new TmIds();
    assert.deepEqual([...ids.numbersOf(['a', 'b']).values()], [1, 2]);
    assert.deepEqual([...new TmIds().numbersOf(['b', 'c']).values()], [2, 3]);
    assert.equal(new TmIds().uuidOf(3), 'c');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'sm-dev', 'tampermonkey-ids.json'), 'utf8')).next, 4);
  } finally {
    if (was === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = was;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CRLF script has its lines rewritten and restored, each keeping its \\r', () => {
  const crlf = SCRIPT.replace(/\n/g, '\r\n');
  const text = rewrittenText(crlf, 'https://sm-dev.invalid/home/me/x.user.js');
  assert.equal(text.split('\n')[2], '// @require     https://sm-dev.invalid/home/me/lib.js\r');
  assert.equal(restoredText(text), crlf);
});
