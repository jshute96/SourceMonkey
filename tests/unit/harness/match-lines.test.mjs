// Unit tests for `match`'s table (matchLines in src/harness/checks.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchLines } from '../../../lib/harness/checks.js';
import { plainLine } from '../../../lib/harness/output-style.js';
import { parseHeader } from '../../../lib/userscript-header.js';

// Just what matchLines reads of a prepared script.
function prepared({ matches = [], includes = [], excludes = [], noframes = false }) {
  return {
    status: 'ok',
    matching: { matches, includes, excludes },
    script: { header: parseHeader(`// ==UserScript==\n// @name T\n${noframes ? '// @noframes\n' : ''}// ==/UserScript==\n`) },
  };
}

const lines = (script, pages) => matchLines(script, pages).lines.map(plainLine);

test('each rule has its own column, blank where it does not cover the row, and frames are under their tab', () => {
  const script = prepared({ matches: ['https://x.test/a/*', 'https://y.test/*'], excludes: ['https://x.test/a/index.html'] });
  assert.deepEqual(lines(script, [
    {
      url: 'https://x.test/a/index.html', name: 'T1', frames: [
        { id: 'F1', parent: 'T1', url: 'https://x.test/a/frame.html?q=1', depth: 1 },
        { id: 'F2', parent: 'F1', url: 'https://y.test/b/c.html', depth: 2 },
      ],
    },
    { url: 'https://z.test/', name: 'T2' },
  ]), [
    'Where   Result    Rules     URL',
    'T1      no match  M1    X3  https://x.test/a/index.html',
    '  F1    match     M1        frame.html?q=1',
    '    F2  match        M2     https://y.test/b/c.html',
    'T2      no match            https://z.test/',
    'Rules:',
    '  M1: @match https://x.test/a/*',
    '  M2: @match https://y.test/*',
    '  X3: @exclude https://x.test/a/index.html',
  ]);
});

test('@noframes is a frame\'s result, with the rules that would have matched', () => {
  const script = prepared({ includes: ['https://x.test/*'], noframes: true });
  assert.deepEqual(lines(script, [{ url: 'https://x.test/', name: 'T1', frames: [{ id: 'F1', parent: 'T1', url: 'https://x.test/f', depth: 1 }] }]), [
    'Where  Result     Rules  URL',
    'T1     match      I1     https://x.test/',
    '  F1   @noframes  I1     f',
    'Rules:',
    '  I1: @include https://x.test/*',
  ]);
});

test('past 8 rules, each row lists only its own; with none, the Rules column goes', () => {
  // https://x.test/a*, https://x.test/ab*, and so on, then another host.
  const many = [...Array.from({ length: 8 }, (_, i) => `https://x.test/${'abcdefgh'.slice(0, i + 1)}*`), 'https://y.test/*'];
  assert.deepEqual(lines(prepared({ matches: many }), [{ url: 'https://x.test/abcdefgh' }, { url: 'https://y.test/' }]).slice(0, 3), [
    'Result  Rules                    URL',
    'match   M1 M2 M3 M4 M5 M6 M7 M8  https://x.test/abcdefgh',
    'match   M9                       https://y.test/',
  ]);
  assert.deepEqual(lines(prepared({ matches: ['https://y.test/*'] }), [{ url: 'https://x.test/' }, { url: 'https://x.test/b' }]), [
    'Result    URL',
    'no match  https://x.test/',
    'no match  https://x.test/b',
    'No @match or @include covers these URLs',
  ]);
});
