// Unit tests for wait.ts's pure parts (compiled to lib/harness/):
// `wait`'s delays, and the message when a tab doesn't settle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { notSettledMessage, parseDelay } = await import('../../../lib/harness/wait.js');

test('parseDelay takes ms and s', () => {
  assert.equal(parseDelay('100ms'), 100);
  assert.equal(parseDelay('5s'), 5000);
  assert.equal(parseDelay('1.5s'), 1500);
  assert.equal(parseDelay('5'), null);
  assert.equal(parseDelay('5m'), null);
  assert.equal(parseDelay('-1s'), null);
});

test('notSettledMessage lists what was busy, capitalizing only its own first word', () => {
  assert.equal(
    notSettledMessage({ n: 1 }, 5000, ['2 requests pending (/api/poll, /ads.js)', 'the DOM is still changing (div#ticker)']),
    'T1 did not settle within 5s: 2 requests pending (/api/poll, /ads.js); the DOM is still changing (div#ticker)',
  );
  // A script's name stays as it is.
  assert.equal(
    notSettledMessage({ n: 2 }, 1500, ['scripts not started yet: Slow', 'a request just finished']),
    'T2 did not settle within 1.5s: Scripts not started yet: Slow; a request just finished',
  );
});
