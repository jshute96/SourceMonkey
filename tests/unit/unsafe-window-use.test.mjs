// Unit tests for the ungranted-`unsafeWindow` source scan
// (src/unsafe-window-use.ts).
//
// The scan answers one question about a script body: does it reference
// `unsafeWindow` without an `@grant` line for it? A `true` moves the
// script to MAIN world and emits the binding, so a false positive costs
// a script its isolation and a false negative leaves it with a
// ReferenceError. These pin where the line is — including the two
// deliberate limits (no regex-literal awareness, body only).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sourceUsesUnsafeWindow } from '../../dist/unsafe-window-use.js';

test('a plain reference counts', () => {
  assert.equal(sourceUsesUnsafeWindow('unsafeWindow.jQuery.ajax();'), true);
  assert.equal(sourceUsesUnsafeWindow('const w = unsafeWindow;'), true);
  assert.equal(sourceUsesUnsafeWindow('if (typeof unsafeWindow !== "undefined") {}'), true);
  assert.equal(sourceUsesUnsafeWindow('foo(unsafeWindow)'), true);
  assert.equal(sourceUsesUnsafeWindow('unsafeWindow["x"] = 1;'), true);
});

test('no mention at all, and the empty cases', () => {
  assert.equal(sourceUsesUnsafeWindow('console.log(window.jQuery);'), false);
  assert.equal(sourceUsesUnsafeWindow(''), false);
  assert.equal(sourceUsesUnsafeWindow(null), false);
  assert.equal(sourceUsesUnsafeWindow(undefined), false);
});

test('a mention in a comment does not move the script', () => {
  // 13 of the 126 ungranted corpus mentions are only in a comment or
  // a string.
  assert.equal(sourceUsesUnsafeWindow('// use unsafeWindow one day\nfoo();'), false);
  assert.equal(sourceUsesUnsafeWindow('/* unsafeWindow.x */ foo();'), false);
  assert.equal(sourceUsesUnsafeWindow('/**\n * @grant unsafeWindow\n */\nfoo();'), false);
  // ...but code after the comment still counts.
  assert.equal(sourceUsesUnsafeWindow('// about unsafeWindow\nunsafeWindow.x = 1;'), true);
});

test('a mention inside a string does not move the script', () => {
  assert.equal(sourceUsesUnsafeWindow('console.log("needs unsafeWindow");'), false);
  assert.equal(sourceUsesUnsafeWindow("throw new Error('no unsafeWindow here');"), false);
  assert.equal(sourceUsesUnsafeWindow('const s = `grant unsafeWindow`;'), false);
  // An escaped quote must not end the string early and expose the rest.
  assert.equal(sourceUsesUnsafeWindow('const s = "a\\" unsafeWindow";'), false);
});

test('a template substitution is code, not text', () => {
  assert.equal(sourceUsesUnsafeWindow('const s = `v=${unsafeWindow.v}`;'), true);
  assert.equal(sourceUsesUnsafeWindow('const s = `${ "unsafeWindow" }`;'), false);
  assert.equal(sourceUsesUnsafeWindow('const s = `a ${ { x: unsafeWindow } } b`;'), true);
});

test('the identifier has to stand alone', () => {
  // A real corpus script granted `unsafeWindows`.
  assert.equal(sourceUsesUnsafeWindow('unsafeWindows.x = 1;'), false);
  assert.equal(sourceUsesUnsafeWindow('myunsafeWindow.x = 1;'), false);
  assert.equal(sourceUsesUnsafeWindow('const x = page.unsafeWindow;'), false);
  assert.equal(sourceUsesUnsafeWindow('const x = page\n  .unsafeWindow;'), false);
  assert.equal(sourceUsesUnsafeWindow('const x = page?.unsafeWindow;'), false);
});

test('a declarator list or destructuring pattern also counts as declaring it', () => {
  // These bind the name just as plainly as `const unsafeWindow =`, and
  // missing them would move a script that reads only its own binding
  // out of isolation for nothing.
  for (const src of [
    'const { unsafeWindow } = window;\nunsafeWindow.x = 1;',
    'const { win: unsafeWindow } = o;\nunsafeWindow.x = 1;',
    'const [unsafeWindow] = xs;\nunsafeWindow.x = 1;',
    'let uw = window, unsafeWindow = uw;\nunsafeWindow.x = 1;',
    'var a, unsafeWindow;\nunsafeWindow.x = 1;',
    'for (const unsafeWindow of xs) { unsafeWindow.x = 1; }',
  ]) {
    assert.equal(sourceUsesUnsafeWindow(src), false, src);
  }
});

test('reading the name after an `=` is a use, not a declaration', () => {
  // The commonest real shape of all, and the one the declarator walk
  // must not claim: everything after the `=` is an initializer.
  assert.equal(sourceUsesUnsafeWindow('const app = unsafeWindow.__PAGE_APP__;'), true);
  assert.equal(sourceUsesUnsafeWindow('const xs = [1, unsafeWindow];'), true);
  assert.equal(sourceUsesUnsafeWindow('const o = { a: unsafeWindow };'), true);
  assert.equal(sourceUsesUnsafeWindow('const t = typeof unsafeWindow;'), true);
  assert.equal(sourceUsesUnsafeWindow('let x = 1; unsafeWindow.y = 2;'), true);
  assert.equal(sourceUsesUnsafeWindow('var f = function () { return unsafeWindow; };'), true);
});

test('a member the source happens to have named unsafeWindow is not a use', () => {
  // A false positive costs a script its isolation, so these don't count.
  assert.equal(sourceUsesUnsafeWindow('const api = { unsafeWindow: window };'), false);
  assert.equal(sourceUsesUnsafeWindow('class A { #unsafeWindow = 1; }'), false);
  assert.equal(sourceUsesUnsafeWindow('label: { break label; }\nconst api = { unsafeWindow: 1 };'), false);
  // The same rule skips a ternary branch. A script using the name there
  // almost always reads it somewhere else too, and that read is found.
  assert.equal(sourceUsesUnsafeWindow('const w = c ? unsafeWindow : window;'), false);
  assert.equal(
    sourceUsesUnsafeWindow('const w = c ? unsafeWindow : window;\nunsafeWindow.x = 1;'),
    true,
  );
});

test('a source that declares the name gets no binding from us', () => {
  // `const unsafeWindow = window.wrappedJSObject || window;` is a real
  // cross-browser idiom. The script reads its own binding, never ours,
  // so nothing needs to move worlds for it.
  const idiom = 'const unsafeWindow = window.wrappedJSObject || window;\nunsafeWindow.x = 1;';
  assert.equal(sourceUsesUnsafeWindow(idiom), false);
  assert.equal(sourceUsesUnsafeWindow('var unsafeWindow = window; unsafeWindow.x;'), false);
  assert.equal(sourceUsesUnsafeWindow('let unsafeWindow;'), false);
  assert.equal(sourceUsesUnsafeWindow('function unsafeWindow() {}'), false);
  // A declaration of something else that merely contains the name isn't
  // one of ours.
  assert.equal(sourceUsesUnsafeWindow('const unsafeWindowRef = unsafeWindow;'), true);
});

test('a regex literal holding a quote can hide a later reference', () => {
  // Documented limit: the scan has no regex-literal state, so the `'`
  // in this character class opens a string that runs on. It costs a
  // missed reference — the script keeps behaving exactly as it does
  // today — never a wrong world.
  assert.equal(sourceUsesUnsafeWindow("s.replace(/['\"]/g, '');\nunsafeWindow.x = 1;"), false);
  // Without the quote, the regex is harmless.
  assert.equal(sourceUsesUnsafeWindow('s.replace(/[ab]/g, "");\nunsafeWindow.x = 1;'), true);
});
