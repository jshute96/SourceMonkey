// Tests for src/markup-response.ts (compiled to dist/markup-response.js).
//
// The predicate that keeps an HTML page — a forge's file-browser view,
// a login wall, a directory listing — from being treated as the
// JavaScript we asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  MarkupResponseError,
  isMarkupContentType,
  isMarkupResponseMessage,
  looksLikeMarkup,
  markupResponseMessage,
} = await import('../../dist/markup-response.js');

test('markup content types are recognized', () => {
  assert.equal(isMarkupContentType('text/html'), true);
  assert.equal(isMarkupContentType('text/html; charset=utf-8'), true);
  assert.equal(isMarkupContentType('text/html-sandboxed'), true);
  assert.equal(isMarkupContentType('application/xhtml+xml'), true);
  // Producers pass a lowercased, trimmed header; a raw one still works.
  assert.equal(isMarkupContentType('  TEXT/HTML  '), true);
});

test('non-markup content types are accepted', () => {
  assert.equal(isMarkupContentType('text/javascript'), false);
  assert.equal(isMarkupContentType('application/javascript'), false);
  assert.equal(isMarkupContentType('text/plain'), false);
  // Common and legitimate for JS — GitHub serves every release asset
  // this way — so it must not be swept up.
  assert.equal(isMarkupContentType('application/octet-stream'), false);
  // A JSON error envelope is a real soft failure, but a mislabelled JS
  // module is just as real; the eval-side catch handles the first.
  assert.equal(isMarkupContentType('application/json'), false);
  // No header at all: the file:// legs often have none.
  assert.equal(isMarkupContentType(''), false);
});

test('a body that opens with a tag is markup', () => {
  assert.equal(looksLikeMarkup('<!DOCTYPE html><html>…'), true);
  assert.equal(looksLikeMarkup('<html lang="en">'), true);
  // Leading whitespace and newlines are skipped.
  assert.equal(looksLikeMarkup('\n\n  \t<!doctype html>'), true);
  // A BOM sits in front of the tag, and `trimStart` will not remove it.
  assert.equal(looksLikeMarkup('﻿<!DOCTYPE html>'), true);
});

test('a script body is not markup, wherever its metadata block sits', () => {
  assert.equal(looksLikeMarkup('// ==UserScript==\n// @name x\n'), false);
  // A license banner above the block is common and supported
  // (`leadingText`), so the test must not be "block at offset 0".
  assert.equal(looksLikeMarkup('/* MIT licensed */\n// ==UserScript==\n'), false);
  assert.equal(looksLikeMarkup('﻿// ==UserScript==\n'), false);
  assert.equal(looksLikeMarkup('(function () { if (a < b) return; })()'), false);
  assert.equal(looksLikeMarkup(''), false);
});

test('a page embedding the script it displays is still markup', () => {
  // The case the position test exists for: a forge blob page contains
  // the file's own lines, metadata block and all, so any
  // search-anywhere check would call this page a userscript.
  const blobPage = [
    '<!DOCTYPE html>',
    '<html><body><table class="highlight">',
    '<tr><td>// ==UserScript==</td></tr>',
    '<tr><td>// @name        Highlight local rooms</td></tr>',
    '<tr><td>// ==/UserScript==</td></tr>',
    '</table></body></html>',
  ].join('\n');
  assert.equal(looksLikeMarkup(blobPage), true);
});

test('the message names the server or the local file, never both', () => {
  const server = markupResponseMessage();
  assert.match(server, /^The server returned an HTML page, not JavaScript; the link may be dead/);

  const local = markupResponseMessage({ localUrl: 'file:///home/me/lib.js' });
  assert.match(local, /^The local file file:\/\/\/home\/me\/lib\.js is an HTML page/);
  // Blaming the server for bytes that came off local disk would be a
  // flatly wrong diagnosis.
  assert.ok(!local.includes('server'));

  // Capitalized, no trailing period: these land both alone and after
  // prefixes like `@require ./lib.js: `.
  for (const msg of [server, local]) {
    assert.equal(msg[0], msg[0].toUpperCase());
    assert.ok(!msg.endsWith('.'));
  }
});

test('the Content-Type is quoted only when it is the evidence', () => {
  // Header-proved: naming it tells the user what to go look at.
  assert.match(
    markupResponseMessage({ contentType: 'text/html' }),
    /\(Content-Type "text\/html"\)/,
  );
  // Body-proved: quoting a Content-Type that says something else would
  // read as a contradiction.
  assert.ok(!markupResponseMessage().includes('Content-Type'));
});

test('MarkupResponseError is distinguishable without matching wording', () => {
  const err = new MarkupResponseError('Could not read x: The server returned an HTML page');
  assert.ok(err instanceof MarkupResponseError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'MarkupResponseError');
  assert.ok(!(new Error('same words') instanceof MarkupResponseError));
});

test('isMarkupResponseMessage recognizes each form markupResponseMessage writes', () => {
  assert.equal(isMarkupResponseMessage(markupResponseMessage()), true);
  assert.equal(isMarkupResponseMessage(markupResponseMessage({ contentType: 'text/html' })), true);
  assert.equal(isMarkupResponseMessage(markupResponseMessage({ localUrl: 'file:///s/lib.js' })), true);
  assert.equal(isMarkupResponseMessage('The server returned HTTP 404'), false);
});
