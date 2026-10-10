// Unit tests for src/harness/frames.ts (compiled to lib/harness/frames.js):
// frame refs, and matching the extension's frames to the page's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchFrameTrees, parseFrameRef } from '../../../lib/harness/frames.js';

test('a frame ref is F3, or T1.F3 with its tab', () => {
  assert.deepEqual(parseFrameRef('F3'), { frame: 3 });
  assert.deepEqual(parseFrameRef('t2.f10'), { tab: 2, frame: 10 });
  assert.equal(parseFrameRef('T2'), null);
  assert.equal(parseFrameRef('F'), null);
  assert.equal(parseFrameRef('T1.3'), null);
});

// The extension's frames: [frameId, parentFrameId, url].
const listed = (rows) => rows.map(([frameId, parentFrameId, url]) => ({ frameId, parentFrameId, documentId: `doc${frameId}`, url }));

test('frames are matched down the tree by URL', () => {
  const frames = listed([[0, -1, 'top'], [5, 0, 'a'], [7, 0, 'b'], [9, 7, 'nested']]);
  const nodes = [
    { key: 'A', parent: null, url: 'a' },
    { key: 'B', parent: null, url: 'b' },
    { key: 'N', parent: 'B', url: 'nested' },
  ];
  assert.deepEqual([...matchFrameTrees(frames, nodes)], [[0, null], [5, 'A'], [7, 'B'], [9, 'N']]);
});

test('a frame whose URL or parent differs stays unmatched', () => {
  const frames = listed([[0, -1, 'top'], [5, 0, 'a'], [9, 5, 'nested']]);
  const nodes = [{ key: 'A', parent: null, url: 'changed' }, { key: 'N', parent: null, url: 'nested' }];
  assert.deepEqual([...matchFrameTrees(frames, nodes)], [[0, null]]);
});

test('a frame under an unmatched one stays unmatched, even with a node of its URL', () => {
  const frames = listed([[0, -1, 'top'], [5, 0, 'a'], [9, 5, 'nested']]);
  // The page has the nested frame's URL, but not under a matched parent.
  const nodes = [{ key: 'X', parent: null, url: 'other' }, { key: 'N', parent: 'X', url: 'nested' }];
  assert.deepEqual([...matchFrameTrees(frames, nodes)], [[0, null]]);
});

test('siblings with one URL keep their earlier matches', () => {
  const frames = listed([[0, -1, 'top'], [3, 0, 'ad'], [4, 0, 'ad']]);
  const nodes = [{ key: 'X', parent: null, url: 'ad' }, { key: 'Y', parent: null, url: 'ad' }];
  // In order the first time; as known after.
  assert.deepEqual([...matchFrameTrees(frames, nodes)], [[0, null], [3, 'X'], [4, 'Y']]);
  assert.deepEqual([...matchFrameTrees(frames, nodes, new Map([[3, 'Y'], [4, 'X']]))], [[0, null], [3, 'Y'], [4, 'X']]);
});

test('no top frame listed (the tab is gone) matches nothing', () => {
  assert.equal(matchFrameTrees([], [{ key: 'A', parent: null, url: 'a' }]).size, 0);
});
