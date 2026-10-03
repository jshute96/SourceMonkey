// Unit tests for src/harness/page-output.ts (compiled to
// lib/harness/page-output.js): which page console lines and uncaught
// errors `sm-dev start` streams.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeOwnRefs, formatConsoleArgs, hostReportedError, isPreludeLine, shortConsoleText, showConsoleLine, showPageError } from '../../../lib/harness/page-output.js';

const SCRIPT = 'sourcemonkey://SourceMonkey/my-script/my-script.user.js';
const PRELUDE = 'sourcemonkey://SourceMonkey/__prelude.js';

const call = (over) => ({ type: 'log', text: 'hi', url: 'https://site.test/app.js', argCount: 1, ...over });

test('console lines from a script show at every level', () => {
  assert.equal(showConsoleLine(call({ url: SCRIPT }), false), true);
  assert.equal(showConsoleLine(call({ url: SCRIPT, type: 'error' }), false), true);
});

test("the page's own errors show only with pageErrors", () => {
  const csp = call({ type: 'error', text: "Connecting to 'x' violates the following Content Security Policy directive", url: 'https://site.test/', argCount: 0 });
  assert.equal(showConsoleLine(csp, false), false);
  assert.equal(showConsoleLine(csp, true), true);
  assert.equal(showConsoleLine(call({ type: 'error' }), false), false);
});

test('a bracketed console call passes, a bracketed browser entry does not', () => {
  assert.equal(showConsoleLine(call({ text: '[my-script] ready' }), false), true);
  const reportOnly = call({ type: 'error', text: '[Report Only] Refused to load the script', argCount: 0 });
  assert.equal(showConsoleLine(reportOnly, false), false);
});

test("the prelude's own lines never show", () => {
  assert.equal(showConsoleLine(call({ text: '[SourceMonkey] started', url: SCRIPT }), true), false);
});

const stack = (url) => `Error: boom\n    at f (${url}:3:9)\n    at g (https://site.test/app.js:1:1)`;

test('a throw from a script body is left to the host when it reports', () => {
  assert.equal(showPageError(stack(SCRIPT), { pageErrors: false, hostReports: true }), false);
  assert.equal(showPageError(stack(SCRIPT), { pageErrors: true, hostReports: true }), false);
  assert.equal(showPageError(stack(SCRIPT), { pageErrors: false, hostReports: false }), true);
});

test("a throw from SourceMonkey's own code shows, since no host reports it", () => {
  assert.equal(showPageError(stack(PRELUDE), { pageErrors: false, hostReports: true }), true);
});

test("the page's own throws show only with pageErrors", () => {
  const own = 'Error: nope\n    at h (https://site.test/app.js:9:9)';
  assert.equal(showPageError(own, { pageErrors: false, hostReports: true }), false);
  assert.equal(showPageError(own, { pageErrors: true, hostReports: true }), true);
});

test('a thrown non-Error value has no stack to judge by, so it shows', () => {
  assert.equal(showPageError('nope', { pageErrors: false, hostReports: true }), true);
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

test('the stream cuts a long console line, with its length', () => {
  assert.equal(shortConsoleText('short'), 'short');
  const long = 'x'.repeat(1500);
  assert.equal(shortConsoleText(long), `${'x'.repeat(1000)}... (1500 chars; logs shows it all)`);
});
