// Unit tests for the comment sm-dev adds to a script it installs in
// another manager (script-mark.ts), and the URL a local one is
// installed from (external-manager.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markedText, readMark, sameScript, withoutMark } from '../../../lib/harness/script-mark.js';
import { installUrlOf } from '../../../lib/harness/external-manager.js';

const SCRIPT = '// ==UserScript==\n// @name x\n// ==/UserScript==\nrun();\n';

test('the comment goes last, and reads back, a path with spaces included', () => {
  const mark = { run: 'D1', started: '2026-10-04T12:00:00.000Z', file: '/home/me/my scripts/x.user.js' };
  const text = markedText(SCRIPT, mark);
  assert.equal(text, `${SCRIPT}// sm-dev: run=D1 started=2026-10-04T12:00:00.000Z file=/home/me/my scripts/x.user.js\n`);
  assert.deepEqual(readMark(text), mark);
  assert.equal(withoutMark(text), SCRIPT);
});

test('marking again replaces the comment; a script without one has none', () => {
  const once = markedText(SCRIPT, { file: '/a.user.js' });
  assert.equal(markedText(once, { file: '/b.user.js' }), `${SCRIPT}// sm-dev: file=/b.user.js\n`);
  assert.equal(readMark(SCRIPT), null);
  assert.equal(withoutMark(SCRIPT), SCRIPT);
});

test('a script without a last newline gets one before the comment', () => {
  const text = markedText('run();', { run: 'D2', started: 'x' });
  assert.equal(text, 'run();\n// sm-dev: run=D2 started=x\n');
  assert.deepEqual(readMark(text), { run: 'D2', started: 'x' });
});

test('two texts are the same script whatever their comments', () => {
  assert.equal(sameScript(markedText(SCRIPT, { file: '/a' }), SCRIPT), true);
  assert.equal(sameScript(markedText(SCRIPT, { file: '/a' }), `${SCRIPT}more();\n`), false);
});

test('a local script installs from sm-dev.invalid; a URL from itself', () => {
  assert.equal(installUrlOf('file:///home/me/x.user.js'), 'https://sm-dev.invalid/home/me/x.user.js');
  assert.equal(installUrlOf('https://example.com/x.user.js'), 'https://example.com/x.user.js');
});
