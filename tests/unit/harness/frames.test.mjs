// Unit tests for src/harness/frames.ts (compiled to lib/harness/frames.js):
// frame ids, frame refs, and matching the extension's frames to the page's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameIds, matchFrameTrees, parseFrameRef } from '../../../lib/harness/frames.js';

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

// A page whose tree of frames can be replaced, as a reload does:
// `[url, [children]]` for each iframe.
function fakePage() {
  const page = { isClosed: () => false, mainFrame: () => main };
  const frame = (url, children = [], parent = null) => {
    const f = { url: () => f.address, address: url, gone: false, kids: [], page: () => page, parentFrame: () => parent, isDetached: () => f.gone, childFrames: () => f.kids };
    f.kids = children.map(([u, c]) => frame(u, c, f));
    return f;
  };
  const main = frame('top');
  const detach = (f) => { f.gone = true; f.kids.forEach(detach); };
  return {
    main,
    load(tree) {
      main.kids.forEach(detach);
      main.kids = tree.map(([u, c]) => frame(u, c, main));
      return main.kids;
    },
  };
}

test('after a reload, frames in the same places with the same URLs get their ids back', () => {
  const ids = new FrameIds();
  const page = fakePage();
  // On a first load, a frame with no URL yet is numbered in its turn.
  const [a, b] = page.load([['a.html'], ['b.html', [['nested.html']]]]);
  a.address = '';
  assert.equal(ids.waiting(a), false);
  a.address = 'a.html';
  assert.deepEqual([ids.number(b.kids[0]), ids.number(a), ids.number(b)], [3, 1, 2]);
  const [a2, b2, c] = page.load([['a.html'], ['b.html?t=2', [['nested.html']]], ['c.html']]);
  // b by its page alone, as its query changed; c is new.
  assert.deepEqual([ids.number(a2), ids.number(b2), ids.number(b2.kids[0]), ids.number(c)], [1, 2, 3, 4]);
  // A frame with no URL yet waits for one to be matched by, left out of
  // listings till then.
  const [x, y] = page.load([['a.html'], ['']]);
  assert.equal(ids.number(x), 1);
  assert.equal(ids.waiting(y), true);
  y.address = 'b.html';
  assert.equal(ids.waiting(y), false);
  assert.equal(ids.number(y), 2);
  // One that navigated before it went is matched by where it ended up.
  y.address = 'other.html';
  const [, z] = page.load([['a.html'], ['other.html']]);
  assert.equal(ids.number(z), 2);
});

test('of two frames with one URL, the earlier gets the earlier id, whichever loads first', () => {
  const ids = new FrameIds();
  const page = fakePage();
  const [a, b] = page.load([['ad.html'], ['ad.html']]);
  assert.deepEqual([ids.number(a), ids.number(b)], [1, 2]);
  const [a2, b2] = page.load([[''], ['ad.html']]);
  // b2 loaded first, but waits behind a2, which hasn't.
  assert.equal(ids.waiting(b2), true);
  a2.address = 'ad.html';
  assert.deepEqual([ids.number(b2), ids.number(a2)], [2, 1]);
});

test('a frame that stays on about:blank waits only so long', (t) => {
  const ids = new FrameIds();
  const page = fakePage();
  const [a] = page.load([['a.html']]);
  ids.number(a);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const [blank] = page.load([['about:blank']]);
  assert.equal(ids.waiting(blank), true);
  now += 5000;
  assert.equal(ids.waiting(blank), false);
  assert.equal(ids.number(blank), 2);
});
