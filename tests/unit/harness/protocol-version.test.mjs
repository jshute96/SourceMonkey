// Unit tests for how a run compares the extension's sm-dev protocol
// version with its own (compareProtocol in src/harness/extension-link.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { compareProtocol } = await import('../../../lib/harness/extension-link.js');
const { SM_DEV_PROTOCOL } = await import('../../../lib/sm-dev-protocol.js');
const { major, minor } = SM_DEV_PROTOCOL;

test('a matching version passes with nothing to say', () => {
  assert.equal(compareProtocol({ major, minor }), null);
});

test('an extension with no version, or an older major, is refused as too old', () => {
  for (const v of [undefined, { major: major - 1, minor: 99 }]) {
    assert.match(compareProtocol(v).error, /^SourceMonkey in this browser is older than this sm-dev/);
  }
});

test('an extension with a newer major is refused, saying to update sm-dev', () => {
  const { error } = compareProtocol({ major: major + 1, minor: 0 });
  assert.match(error, /^This sm-dev is older than SourceMonkey in this browser/);
  assert.match(error, /Update sm-dev: Run pnpm run build/);
});

test('a minor that differs starts the run with a note naming the older side and its fix', () => {
  const ours = { major: 2, minor: 3 };
  const newer = compareProtocol({ major: 2, minor: 4 }, ours);
  assert.equal(newer.error, undefined);
  assert.match(newer.note, /^This sm-dev is older .* Update sm-dev: /);
  const older = compareProtocol({ major: 2, minor: 2 }, ours);
  assert.equal(older.error, undefined);
  assert.match(older.note, /^SourceMonkey in this browser is older .* Update it: /);
});
