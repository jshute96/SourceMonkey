// How `--json` results and log messages are marked on their way to the client,
// and printed there (src/harness/json-output.ts).

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResult, markedLine, STDERR_LINE, withLayout } from '../../../lib/harness/json-output.js';

test('a result is laid out on one line or multi-line, its command\'s own layout winning', () => {
  const line = jsonResult('tabs', { tabs: [{ id: 'T1' }] });
  const single = '{"command":"tabs","tabs":[{"id":"T1"}]}';
  const multi = '{\n  "command": "tabs",\n  "tabs": [\n    {\n      "id": "T1"\n    }\n  ]\n}';
  assert.deepEqual(markedLine(line, 'single'), { stderr: false, text: single });
  assert.equal(markedLine(line, 'multi').text, multi);
  assert.equal(markedLine(withLayout(line, 'multi'), 'single').text, multi);
  assert.equal(markedLine(withLayout(line, 'single'), 'multi').text, single);
});

test('a log message goes to stderr', () => {
  assert.deepEqual(markedLine(`${STDERR_LINE}[sm-dev] note`, 'single'), { stderr: true, text: '[sm-dev] note' });
  assert.equal(markedLine('plain', 'single'), null);
});
