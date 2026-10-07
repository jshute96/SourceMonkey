// Tests for src/extension/copy-preference.ts: which copy of a script is
// preferred, inside one collection and anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareInCollection, comparePreferred, preferredCopy } from '../../dist/extension/copy-preference.js';

function copy(id, extra = {}) {
  return {
    id, enabled: true, collectionOn: true, collectionName: 'C', version: null, location: `/${id}`, ...extra,
  };
}
const pick = (copies, compare) => preferredCopy(copies, (c) => c, compare)?.id;

test('in a collection: an active copy before an inactive one, however recent', () => {
  const copies = [copy('inactive', { enabled: false, inactiveSince: 100 }), copy('active', { activeSince: 1 })];
  assert.equal(pick(copies, compareInCollection), 'active');
});

test('in a collection: the later activeSince, then the later inactiveSince, then no signal', () => {
  assert.equal(pick([copy('a', { activeSince: 1 }), copy('b', { activeSince: 2 })], compareInCollection), 'b');
  const off = { enabled: false };
  assert.equal(pick([copy('a', { ...off }), copy('b', { ...off, inactiveSince: 2 })], compareInCollection), 'b');
});

test('in a collection: with no times, highest version, a missing one last, then location', () => {
  assert.equal(pick([copy('a', { version: '1.2' }), copy('b', { version: '1.10' })], compareInCollection), 'b');
  assert.equal(pick([copy('a'), copy('b', { version: '0.1' })], compareInCollection), 'b');
  assert.equal(pick([copy('b'), copy('a')], compareInCollection), 'a');
});

test('anywhere: enabled collection, then ticked under a disabled one, then unticked under one', () => {
  const copies = [
    copy('unticked', { enabled: false, collectionOn: false, inactiveSince: 9 }),
    copy('ticked', { collectionOn: false, inactiveSince: 1 }),
  ];
  assert.equal(pick(copies, comparePreferred), 'ticked');
  copies.push(copy('own-box-off', { enabled: false }));
  assert.equal(pick(copies, comparePreferred), 'own-box-off');
});

test('anywhere: recency before collection name, collection name before version', () => {
  const off = { enabled: false };
  const recent = [copy('a', { ...off, collectionName: 'A' }), copy('b', { ...off, collectionName: 'B', inactiveSince: 5 })];
  assert.equal(pick(recent, comparePreferred), 'b');
  const named = [copy('a', { ...off, collectionName: 'B', version: '9' }), copy('b', { ...off, collectionName: 'A', version: '1' })];
  assert.equal(pick(named, comparePreferred), 'b');
});

test('no copies, no pick', () => {
  assert.equal(pick([], comparePreferred), undefined);
});
