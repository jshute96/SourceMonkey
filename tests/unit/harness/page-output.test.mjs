// Unit tests for src/harness/page-output.ts (compiled to
// lib/harness/page-output.js): whose the page's console lines and
// uncaught errors are, the run's scripts' or the page's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consoleSource, decodeOwnRefs, formatConsoleArgs, hostReportedError, isPreludeLine, pageErrorSource } from '../../../lib/harness/page-output.js';

const SCRIPT = 'sourcemonkey://SourceMonkey/my-script/my-script.user.js';
const PRELUDE = 'sourcemonkey://SourceMonkey/__prelude.js';
const PAGE = 'https://site.test/app.js';

const call = (over) => ({ type: 'log', text: 'hi', url: PAGE, frames: [], argCount: 1, ...over });

test('a console call from a script is the script\'s, at every level', () => {
  assert.equal(consoleSource(call({ url: SCRIPT })), 'script');
  assert.equal(consoleSource(call({ url: SCRIPT, type: 'error' })), 'script');
});

test('a call through a page helper is the script\'s when its stack has the script', () => {
  assert.equal(consoleSource(call({ frames: [PAGE, SCRIPT] })), 'script');
  assert.equal(consoleSource(call({ frames: [PAGE, PAGE] })), 'page');
});

test('a call from SourceMonkey\'s world is the script\'s, stack or not', () => {
  assert.equal(consoleSource(call({ url: '', extensionWorld: true })), 'script');
});

test('the page\'s own lines, and the browser\'s entries, are the page\'s', () => {
  assert.equal(consoleSource(call({ type: 'error' })), 'page');
  // Bracketed, as many sites log: no longer taken for a script's.
  assert.equal(consoleSource(call({ text: '[my-script] ready' })), 'page');
  const csp = call({ type: 'error', text: "Connecting to 'x' violates the following Content Security Policy directive", url: SCRIPT, argCount: 0 });
  assert.equal(consoleSource(csp), 'page');
});

const stack = (url) => `Error: boom\n    at f (${url}:3:9)\n    at g (https://site.test/app.js:1:1)`;

test('a throw from a script body is left to the host when it reports', () => {
  assert.equal(pageErrorSource(stack(SCRIPT), true), null);
  assert.equal(pageErrorSource(stack(SCRIPT), false), 'script');
});

test("a throw from SourceMonkey's own code is the scripts', since no host reports it", () => {
  assert.equal(pageErrorSource(stack(PRELUDE), true), 'script');
});

test("the page's own throws are the page's", () => {
  assert.equal(pageErrorSource('Error: nope\n    at h (https://site.test/app.js:9:9)', true), 'page');
});

test('a thrown non-Error value has no stack to judge by, so it counts as the scripts\'', () => {
  assert.equal(pageErrorSource('nope', true), 'script');
});

test('our own stack refs are decoded once for display; others are left as they are', () => {
  // A file named `a%20b.user.js` is in its sourceURL as `a%2520b`.
  const own = 'sourcemonkey://SourceMonkey/a%2520b/a%2520b.user.js';
  const shown = 'sourcemonkey://SourceMonkey/a%20b/a%20b.user.js';
  assert.equal(decodeOwnRefs(`boom\n    at f (${own}:3:7)`), `boom\n    at f (${shown}:3:7)`);
  const cdn = 'https://cdn.test/a%20b.js:1:2';
  assert.equal(decodeOwnRefs(`at ${cdn} and ${own}:1:1`), `at ${cdn} and ${shown}:1:1`);
  assert.equal(decodeOwnRefs('100% plain'), '100% plain');
});

test('the prelude\'s lines and host-reported throws are recognized as repeats', () => {
  assert.equal(isPreludeLine('[SourceMonkey] x threw'), true);
  assert.equal(isPreludeLine('[x] SourceMonkey'), false);
  assert.equal(hostReportedError(`Error: x\n    at f (${SCRIPT}:1:2)`, true), true);
  assert.equal(hostReportedError(`Error: x\n    at f (${SCRIPT}:1:2)`, false), false);
  assert.equal(hostReportedError(`Error: x\n    at f (${PRELUDE}:1:2)`, true), false);
});

test('a console call\'s % directives are applied as the console does', () => {
  // %c takes its CSS and shows nothing.
  assert.equal(formatConsoleArgs(['%cAuto Close YouTube Ads:', 'font-weight: bold;color: purple;', 'Started']), 'Auto Close YouTube Ads: Started');
  assert.equal(formatConsoleArgs(['%c[a]%c b', 'color: red', '', 'c']), '[a] b c');
  assert.equal(formatConsoleArgs(['%s has %d items, 100%%', 'list', '3.7']), 'list has 3 items, 100%');
  // Nothing to take: as written.
  assert.equal(formatConsoleArgs(['50% done']), '50% done');
  assert.equal(formatConsoleArgs(['%s and %s', 'one']), 'one and %s');
  assert.equal(formatConsoleArgs(['plain', 'words']), 'plain words');
});
