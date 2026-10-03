// Unit tests for src/extension/sw-teardown.ts: the `No SW` recognizer and the
// unhandledrejection handler that marks it handled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSwTeardownError, installSwTeardownHandler } from '../../dist/extension/sw-teardown.js';

test('isSwTeardownError: matches Chrome\'s teardown rejection only', () => {
  assert.equal(isSwTeardownError(new Error('No SW')), true);
  assert.equal(isSwTeardownError({ message: 'No SW' }), true);
  assert.equal(isSwTeardownError('No SW'), true);
  assert.equal(isSwTeardownError(new Error('No SW registered for scope')), false);
  assert.equal(isSwTeardownError(new Error('boom')), false);
  assert.equal(isSwTeardownError(null), false);
  assert.equal(isSwTeardownError(undefined), false);
});

test('installSwTeardownHandler: prevents default for No SW, leaves others alone', () => {
  const target = new EventTarget();
  const savedSelf = globalThis.self;
  const savedInfo = console.info;
  globalThis.self = target;
  console.info = () => {};
  try {
    installSwTeardownHandler();
    const fire = (reason) => {
      const ev = new Event('unhandledrejection', { cancelable: true });
      ev.reason = reason;
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    assert.equal(fire(new Error('No SW')), true);
    assert.equal(fire(new Error('something real')), false);
  } finally {
    globalThis.self = savedSelf;
    console.info = savedInfo;
  }
});
