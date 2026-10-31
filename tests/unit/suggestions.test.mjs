// Tests for src/suggestions.ts (compiled to dist/suggestions.js):
// which suggestions the collections page's box lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUGGESTIONS, pendingSuggestions,
} from '../../dist/suggestions.js';

const ids = (list) => list.map((s) => s.id);
const header = (name, namespace) => ({
  tags: [{ tag: 'name', value: name }, ...(namespace ? [{ tag: 'namespace', value: namespace }] : [])],
});

test('pendingSuggestions: everything on an empty profile', () => {
  assert.deepEqual(ids(pendingSuggestions([], [])), ids(SUGGESTIONS));
});

test('pendingSuggestions: a collection counts as installed by any of its paths', () => {
  for (const path of [
    'https://github.com/jshute96/SourceMonkey/tree/main/tests/examples',
    'https://jshute96.github.io/SourceMonkey/tests/examples/script_manifest.json',
  ]) {
    assert.ok(!ids(pendingSuggestions([path], [])).includes('sourcemonkey-examples'), path);
  }
});

test('pendingSuggestions: a script counts as installed by @namespace and @name', () => {
  const name = 'Show SourceMonkey test status on Greasy Fork';
  for (const n of [name, 'SourceMonkey test status on Greasy Fork']) {
    const installed = pendingSuggestions([], [null, header(n, 'https://github.com/jshute96/SourceMonkey')]);
    assert.deepEqual(ids(installed), ['sourcemonkey-examples'], n);
  }
  // Same name, other namespace: a different script.
  assert.equal(pendingSuggestions([], [header(name, 'https://example.com')]).length, SUGGESTIONS.length);
});
