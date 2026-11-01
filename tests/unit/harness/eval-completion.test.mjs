// Tests for src/harness/eval-completion.ts: which statement of an
// async function body becomes its `return`, checked by running the
// rewritten body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returningLastExpression } from '../../../lib/harness/eval-completion.js';

const AsyncFunction = (async () => {}).constructor;

// What the rewritten body gives when run; null when it isn't rewritten.
async function run(code) {
  const body = returningLastExpression(code);
  return body === null ? null : new AsyncFunction(body)();
}

test('returningLastExpression: the last expression statement is the value', async () => {
  const cases = [
    ['await 1;\n"x";', 'x'],
    ['await 1; "x"', 'x'],
    ['const a = await Promise.resolve(2)\nconst b = 3\na + b', 5],
    ['let n = await 1;\nn += 1;\nn', 2],
    ['const o = await { v: 4 };\no.v', 4],
    // An expression over lines is returned whole.
    ['const a = await 1\nconst b = [a,\n  a + 1]\nb\n  .map((x) => x * 2)\n  .join(",")', '2,4'],
    // A `;` or `//` inside a string or comment doesn't end anything.
    ['await 0; "a;b"', 'a;b'],
    ['await 0\n"x" // note; more', 'x'],
    // Comment lines and blank lines after it.
    ['await 0\n7\n// done\n\n', 7],
    // A statement with its own `return` keeps its meaning.
    ['await 0\nif (false) return 1;\n2', 2],
    ['for (let i = 0; i < 3; i++) await i;\n"after"', 'after'],
  ];
  for (const [code, want] of cases) assert.equal(await run(code), want, code);
});

test('returningLastExpression: null when the last statement is no expression', () => {
  for (const code of [
    'const a = await 1',
    'await 1;\nreturn 5',
    'await 1;\nif (true) { 3 }',
    '',
    // A line starting with `(` continues the one before: no split there.
    'const f = await ((x) => x)\n(1)',
    // A declaration at the end stays one, so it's still hoisted.
    'await 0\nf()\nfunction f() {}',
    'await 0\nclass C {}',
  ]) assert.equal(returningLastExpression(code), null, code);
});

test('returningLastExpression: no cut inside a comment or before a loop body', async () => {
  // The `;` in the comment is no cut, so the commented-out call stays out.
  globalThis.__calls = 0;
  assert.equal(await run('await 0\nconst y = 1 // see; __calls++\ny'), 1);
  assert.equal(globalThis.__calls, 0);
  // A loop's unbraced body runs every time; the value is the next line.
  assert.equal(await run('let n = 0\nfor (const x of [1, 2, 3])\n  n += await x\nn'), 6);
  assert.equal(returningLastExpression('await 0\nfor (const x of [1, 2])\n  x'), null);
  delete globalThis.__calls;
});
