// Unit tests for the SW-side GM_registerMenuCommand registry.
//
// The module is pure in-memory state with no chrome.* dependency, so
// it imports directly. What's worth pinning down is the document
// scoping: the registry holds commands for one page per tab (its top
// document and its frames' documents), and both the clear and the
// unregister paths have to respect that or a navigation can delete
// registrations nothing will resend (see the fresh-document race in
// docs/GM-APIs.md, and docs/frames.md).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  registerMenuCommand,
  unregisterMenuCommand,
  getMenuCommandsForTab,
  findMenuCommand,
  clearTab,
  pruneDocuments,
  topDocument,
  hasFrameDocuments,
} = await import('../../dist/extension/gm-menu.js');

// Each test picks its own tabId so the module-level state can't leak
// between them.
let nextTabId = 1;
const freshTab = () => nextTabId++;

const names = (tabId, scriptId) =>
  (getMenuCommandsForTab(tabId).get(scriptId) ?? []).map((c) => c.name);

test('registerMenuCommand keeps declaration order and reports visible changes', () => {
  const tab = freshTab();
  assert.equal(registerMenuCommand(tab, 'doc', 's1', 'c1', 'First'), true);
  assert.equal(registerMenuCommand(tab, 'doc', 's1', 'c2', 'Second'), true);
  assert.deepEqual(names(tab, 's1'), ['First', 'Second']);

  // Same id, same name — nothing visible changed, so no menu rebuild.
  assert.equal(registerMenuCommand(tab, 'doc', 's1', 'c1', 'First'), false);
  // Same id, new name — an in-place update, order preserved.
  assert.equal(registerMenuCommand(tab, 'doc', 's1', 'c1', 'Renamed'), true);
  assert.deepEqual(names(tab, 's1'), ['Renamed', 'Second']);
});

test('a register from a new document replaces the previous document state', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'docA', 's1', 'c1', 'From A');
  registerMenuCommand(tab, 'docB', 's1', 'c2', 'From B');
  // Not appended: the previous document's callbacks died with it.
  assert.deepEqual(names(tab, 's1'), ['From B']);
});

test('clearTab keeps the document being navigated to', () => {
  const tab = freshTab();
  // The race the scoping exists for: the new document's wrapper
  // registers before the navigation's clear runs.
  registerMenuCommand(tab, 'docB', 's1', 'c1', 'From B');
  clearTab(tab, 'docB');
  assert.deepEqual(names(tab, 's1'), ['From B']);
});

test('clearTab drops any other document, including a later one on bfcache restore', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'docB', 's1', 'c1', 'From B');
  // Back/forward to an earlier document: docB's rows can never fire.
  clearTab(tab, 'docA');
  assert.deepEqual([...getMenuCommandsForTab(tab).keys()], []);
});

test('clearTab with no document, or an unknown one, drops everything', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'docA', 's1', 'c1', 'From A');
  clearTab(tab);
  assert.deepEqual([...getMenuCommandsForTab(tab).keys()], []);

  // An empty id means "caller doesn't know" — it must not protect
  // state it can't identify.
  registerMenuCommand(tab, 'docA', 's1', 'c1', 'From A');
  clearTab(tab, '');
  assert.deepEqual([...getMenuCommandsForTab(tab).keys()], []);
});

test('unregisterMenuCommand only touches its own document', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'docB', 's1', 'shared', 'From B');
  // A stale unregister from the previous document, carrying an id that
  // legitimately exists in both (an explicit `{id: 'shared'}`).
  assert.equal(unregisterMenuCommand(tab, 'docA', 's1', 'shared'), false);
  assert.deepEqual(names(tab, 's1'), ['From B']);

  assert.equal(unregisterMenuCommand(tab, 'docB', 's1', 'shared'), true);
  assert.deepEqual(names(tab, 's1'), []);
  // Last command gone → the tab drops out of the registry entirely.
  assert.deepEqual([...getMenuCommandsForTab(tab).keys()], []);
});

test('unregisterMenuCommand is silent on unknown ids', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'doc', 's1', 'c1', 'First');
  assert.equal(unregisterMenuCommand(tab, 'doc', 's1', 'nope'), false);
  assert.equal(unregisterMenuCommand(tab, 'doc', 'other-script', 'c1'), false);
  assert.equal(unregisterMenuCommand(freshTab(), 'doc', 's1', 'c1'), false);
});

test('findMenuCommand resolves a click back to its entry', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'doc', 's1', 'c1', 'First');
  assert.deepEqual(findMenuCommand(tab, 's1', 'c1'), { commandId: 'c1', name: 'First', documentId: 'doc' });
  assert.equal(findMenuCommand(tab, 's1', 'gone'), null);
  assert.equal(findMenuCommand(tab, 'other-script', 'c1'), null);
});

test('getMenuCommandsForTab returns an empty map for an untracked tab', () => {
  assert.deepEqual([...getMenuCommandsForTab(freshTab()).keys()], []);
});

// ---- Frames: one page, several documents ----

test('a frame\'s commands merge after the top frame\'s, whichever registered first', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'frame1', 's1', 'c1', 'From frame', 'top');
  registerMenuCommand(tab, 'top', 's1', 'c1', 'From top');
  assert.deepEqual(names(tab, 's1'), ['From top', 'From frame']);
  assert.equal(topDocument(tab), 'top');
});

test('the same commandId in two documents stays apart, and resolves by document', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'top', 's1', 'shared', 'Top');
  registerMenuCommand(tab, 'frame1', 's1', 'shared', 'Frame', 'top');
  assert.equal(findMenuCommand(tab, 's1', 'shared', 'frame1').name, 'Frame');
  assert.equal(findMenuCommand(tab, 's1', 'shared').name, 'Top');
  assert.equal(unregisterMenuCommand(tab, 'frame1', 's1', 'shared'), true);
  assert.deepEqual(names(tab, 's1'), ['Top']);
});

test('a register under another page replaces the tab\'s commands, frames included', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'topA', 's1', 'c1', 'A');
  registerMenuCommand(tab, 'frameA', 's1', 'c2', 'A frame', 'topA');
  registerMenuCommand(tab, 'frameB', 's1', 'c3', 'B frame', 'topB');
  assert.deepEqual(names(tab, 's1'), ['B frame']);
});

test('clearTab keeps the new page\'s frames that registered before the clear', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'frameB', 's1', 'c1', 'B frame', 'topB');
  clearTab(tab, 'topB');
  assert.deepEqual(names(tab, 's1'), ['B frame']);
  clearTab(tab, 'topC');
  assert.deepEqual([...getMenuCommandsForTab(tab).keys()], []);
});

test('pruneDocuments drops frames that are gone, never the top frame', () => {
  const tab = freshTab();
  registerMenuCommand(tab, 'top', 's1', 'c1', 'Top');
  registerMenuCommand(tab, 'frame1', 's1', 'c2', 'Frame 1', 'top');
  registerMenuCommand(tab, 'frame2', 's1', 'c3', 'Frame 2', 'top');
  assert.equal(pruneDocuments(tab, new Set(['frame2'])), true);
  assert.deepEqual(names(tab, 's1'), ['Top', 'Frame 2']);
  assert.equal(pruneDocuments(tab, new Set(['frame2'])), false);
  assert.equal(hasFrameDocuments(tab), true);
  pruneDocuments(tab, new Set());
  assert.equal(hasFrameDocuments(tab), false);
});
