// Tests for src/eval-hook.ts (compiled to dist/eval-hook.js): where the
// hook goes in a program, and the keys it's kept under.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { directivePrologueEnd, evalHookKey, leadingFunctionBody, withEvalHook } from '../../dist/eval-hook.js';

test('directivePrologueEnd: past the directives, comments and the header skipped', () => {
  const cases = [
    ['x = 1;', 0],
    ['', 0],
    ['"use strict";\nx', '"use strict";'.length],
    ['\'use strict\'\nx', '\'use strict\''.length],
    ['// ==UserScript==\n// ==/UserScript==\n"use strict"; // why\nx', '// ==UserScript==\n// ==/UserScript==\n"use strict";'.length],
    ['/* a\n */ "use strict";"b";\nx', '/* a\n */ "use strict";"b";'.length],
    ['"use strict"', '"use strict"'.length],
    ['"a\\"b";x', '"a\\"b";'.length],
  ];
  for (const [program, end] of cases) assert.equal(directivePrologueEnd(program), end, program);
});

test('directivePrologueEnd: a string that starts an expression is no directive', () => {
  for (const program of ['"abc".length;', '"a" + b;', '"a"\n(x)', '"a"\n.x', '"a"\nin x', '"a\nb"']) {
    assert.equal(directivePrologueEnd(program), 0, program);
  }
  // The directive before it still counts.
  assert.equal(directivePrologueEnd('"use strict";\n"a".length'), '"use strict";'.length);
});

test('withEvalHook: the program stays strict, and the hook reads its scope', () => {
  const key = evalHookKey('unit');
  const program = withEvalHook('"use strict";\nconst n = 7;\nreturn (function () { return this; })();', key, 's1');
  assert.equal(new Function(program)(), undefined);
  assert.equal(globalThis[key].s1('n * 6'), 42);
  // Named for stack traces, not after the script id it's kept under.
  // Called detached, as sm-dev calls it.
  const hook = globalThis[key].s1;
  assert.equal(hook.name, 'sm-dev eval');
  assert.match(hook('new Error().stack'), /\n\s+at sm-dev eval \(/);
  assert.doesNotMatch(hook('new Error().stack'), /\[as /);
  assert.equal(program.split('\n').length, 3);
});

test('leadingFunctionBody: the IIFE shapes scripts open with', () => {
  const header = '// ==UserScript==\n// @name x\n// ==/UserScript==\n';
  const opens = [
    '(function () {',
    '(function named(a, b = (1)) {',
    ';(function() {',
    '(async function () {',
    '(() => {',
    '(async () => {',
    '((win) => {',
    '(win => {',
    '!function () {',
    'void function () {',
    '((function () {',
    '(function* () {',
  ];
  for (const open of opens) {
    const program = `${header}${open} body })();`;
    assert.equal(leadingFunctionBody(program, 0), header.length + open.length, open);
  }
});

test('leadingFunctionBody: anything else is no IIFE', () => {
  for (const program of ['function helper(sel) { return sel; }', 'async function main() {}', 'x => {}', 'const x = 1;', '(a, b);', '(() => x)();', '(x)\n=> {}', 'foo(function () {});', '(window.f || function () {})();', '']) {
    assert.equal(leadingFunctionBody(program, 0), -1, program);
  }
});

test('withEvalHook: inside the IIFE too, after its own "use strict", seeing its locals', () => {
  const key = evalHookKey('unit-iife');
  const program = withEvalHook([
    '// ==UserScript==',
    '// ==/UserScript==',
    '(function () {',
    '  \'use strict\';',
    '  const hidden = /[)}]/.source + `${"}"}`;',
    '  globalThis.iifeStrict = (function () { return this; })() === undefined;',
    '})();',
  ].join('\n'), key, 's2');
  new Function(program)();
  assert.equal(globalThis.iifeStrict, true);
  assert.equal(globalThis[key].s2('hidden'), '[)}]}');
  assert.equal(program.split('\n').length, 7);
});

test('withEvalHook: a function body of one directive stays strict', () => {
  const key = evalHookKey('unit-short');
  const program = withEvalHook('(function () { "use strict" })();', key, 's3');
  assert.match(program, /"use strict";\(globalThis/);
});
