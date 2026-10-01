// Unit tests for src/harness/page-output.ts (compiled to
// lib/harness/page-output.js): which page console lines and uncaught
// errors `sm-dev start` streams.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeOwnRefs, hostReportedError, isPreludeLine, showConsoleLine, showPageError } from '../../lib/harness/page-output.js';

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
