// Tests for src/require-exports.ts (compiled to dist/require-exports.js).
//
// The parser is intentionally lenient: it trusts JSHint-style
// `/* exported X, Y, Z */` directives and ignores anything that
// isn't a valid JS identifier. We only need to cover the formatting
// variations actually used by real-world userscript libraries.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterForwardableNames,
  parseExportedNames,
} from '../../dist/require-exports.js';

test('parseExportedNames: returns [] when no directive is present', () => {
  assert.deepEqual(parseExportedNames('const x = 1;'), []);
});

test('parseExportedNames: single name on one line', () => {
  assert.deepEqual(parseExportedNames('/* exported foo */'), ['foo']);
});

test('parseExportedNames: comma-separated list', () => {
  assert.deepEqual(parseExportedNames('/* exported foo, bar, baz */'), ['foo', 'bar', 'baz']);
});

test('parseExportedNames: whitespace-only separator', () => {
  // JSHint accepts both forms.
  assert.deepEqual(parseExportedNames('/* exported foo bar baz */'), ['foo', 'bar', 'baz']);
});

test('parseExportedNames: multi-line JSDoc-style block (the utilsjs.js shape)', () => {
  const src = `/* exported
 * $ $$
 * addClass removeClass toggleClass
 * removeEls removeSelection
 * on off make
 * debounce
 */`;
  assert.deepEqual(
    parseExportedNames(src),
    ['$', '$$', 'addClass', 'removeClass', 'toggleClass', 'removeEls', 'removeSelection', 'on', 'off', 'make', 'debounce'],
  );
});

test('parseExportedNames: keyword match is case-insensitive (JSHint is tolerant)', () => {
  assert.deepEqual(parseExportedNames('/* Exported FOO */'), ['FOO']);
  assert.deepEqual(parseExportedNames('/* EXPORTED bar */'), ['bar']);
});

test('parseExportedNames: dollar / underscore identifiers parse', () => {
  assert.deepEqual(parseExportedNames('/* exported $ $$ _, __, _x */'), ['$', '$$', '_', '__', '_x']);
});

test('parseExportedNames: invalid tokens (numbers, punctuation) silently dropped', () => {
  // Robustness: garbage in the directive shouldn't kill parsing of
  // the valid names alongside it.
  assert.deepEqual(parseExportedNames('/* exported 1foo, bar, !baz, qux */'), ['bar', 'qux']);
});

test('parseExportedNames: multiple directives are unioned in first-seen order', () => {
  const src = `/* exported a, b */\nconst a=1;\n/* exported b, c */`;
  assert.deepEqual(parseExportedNames(src), ['a', 'b', 'c']);
});

test('parseExportedNames: duplicate names within one directive are dedup\'d', () => {
  assert.deepEqual(parseExportedNames('/* exported foo, foo, bar */'), ['foo', 'bar']);
});

test('parseExportedNames: ignores `exports` as a keyword (only `exported` matches)', () => {
  // JSHint has a separate `exports` directive with different
  // semantics. Don't accidentally hijack it.
  assert.deepEqual(parseExportedNames('/* exports foo */'), []);
});

test('parseExportedNames: works when directive sits anywhere in the file, not just the top', () => {
  const src = `const x = 1;\n// running comment\n/* exported y */\nconst y = 2;`;
  assert.deepEqual(parseExportedNames(src), ['y']);
});

test('filterForwardableNames: GM_* names are dropped', () => {
  // Forwarding `GM_foo` would redeclare a `const` we emit in the
  // main-body wrap (SyntaxError at parse).
  assert.deepEqual(filterForwardableNames(['GM_setValue', 'foo', 'GM_info']), ['foo']);
});

test('filterForwardableNames: __sm* names are dropped', () => {
  // SourceMonkey's internal namespace. A require that exports
  // `__smE` is almost certainly trying to clobber our wrap.
  assert.deepEqual(filterForwardableNames(['__smE', '__smHack', 'ok']), ['ok']);
});

test('filterForwardableNames: bare `GM` (GM4 namespace) is dropped', () => {
  // gm-bindings.ts emits `const GM = Object.freeze({…})`; a
  // `var{GM}=…` destructure would redeclare it (SyntaxError).
  assert.deepEqual(filterForwardableNames(['GM', 'ok']), ['ok']);
});

test('filterForwardableNames: `unsafeWindow` is dropped', () => {
  // gm-bindings.ts emits `const unsafeWindow = window;`. Same
  // redeclare-const-as-var SyntaxError hazard.
  assert.deepEqual(filterForwardableNames(['unsafeWindow', 'ok']), ['ok']);
});

test('filterForwardableNames: reserved words / keywords are dropped', () => {
  // `var{null}=…` is a hard parse error. `var{let}=…` /
  // `var{eval}=…` etc. would slip past in sloppy mode but are
  // clearly user error in a /* exported */ line. Refuse to emit
  // either case.
  const bad = ['null', 'true', 'false', 'undefined', 'this', 'class',
               'let', 'const', 'var', 'return', 'eval', 'arguments'];
  assert.deepEqual(filterForwardableNames([...bad, 'ok']), ['ok']);
});

test('filterForwardableNames: passes through plain names', () => {
  assert.deepEqual(filterForwardableNames(['on', '$', 'helper']), ['on', '$', 'helper']);
});
