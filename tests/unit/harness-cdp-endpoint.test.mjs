// Unit tests for `cdpEndpoint` in src/harness/run.ts (compiled to
// lib/harness/run.js): the forms `sm-dev --browser` accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cdpEndpoint } from '../../lib/harness/run.js';

test('a port alone means this machine', () => {
  assert.equal(cdpEndpoint('9222'), 'http://127.0.0.1:9222');
  assert.equal(cdpEndpoint(':9222'), 'http://127.0.0.1:9222');
});

test('a host with no scheme gets http://', () => {
  assert.equal(cdpEndpoint('127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(cdpEndpoint('localhost:9222'), 'http://localhost:9222');
});

test('a URL is kept as it is', () => {
  assert.equal(cdpEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(cdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc'), 'ws://127.0.0.1:9222/devtools/browser/abc');
});

test('spaces and a trailing slash are dropped', () => {
  assert.equal(cdpEndpoint(' 9222 '), 'http://127.0.0.1:9222');
  assert.equal(cdpEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
});

test('an IPv6 host takes brackets, as in a URL', () => {
  assert.equal(cdpEndpoint('[::1]:9222'), 'http://[::1]:9222');
});
