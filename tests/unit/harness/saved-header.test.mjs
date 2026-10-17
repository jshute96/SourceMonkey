// Unit tests for `savedHeaderLines` and `readSavedHeader`: the URL and
// userscripts a saved page's header records, for `--from-saved` and
// `serveHtml`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSavedHeader, savedHeaderLines } from '../../../lib/harness/save-html.js';

test('reads the URL and each userscript line', () => {
  const html = [
    '<!DOCTYPE html>',
    '<!-- saved from url=(0024)https://example.test/a?b -->',
    '<!-- SourceMonkey: userscript active: Tweaks 1.2.0 -->',
    '<!-- SourceMonkey: userscript active: A much longer name 0.3 -->',
    '<html><body></body></html>',
  ].join('\n');
  assert.deepEqual(readSavedHeader(html), {
    url: 'https://example.test/a?b',
    userscripts: ['Tweaks 1.2.0', 'A much longer name 0.3'],
  });
});

test('reads the URL Chrome\'s Save Page As records', () => {
  const html = '<!DOCTYPE html>\n<!-- saved from url=(0020)https://example.test -->\n<html lang="en"><head></head></html>';
  assert.deepEqual(readSavedHeader(html), { url: 'https://example.test', userscripts: [] });
});

test('ignores the same comments inside the page', () => {
  const html = '<html><body><!-- saved from url=(0020)https://example.test --><!-- SourceMonkey: userscript active: X --></body></html>';
  assert.deepEqual(readSavedHeader(html), { url: null, userscripts: [] });
});

test('writes a URL with -- as it is, and reads it back', () => {
  const url = 'https://xn--bcher-kva.example/a--b?q=c--d';
  const lines = savedHeaderLines(url, ['Name -- with dashes 1.0', 'Ends early --> not']);
  assert.equal(lines[0], `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->`);
  const html = ['<!DOCTYPE html>', ...lines, '<html><body></body></html>'].join('\n');
  assert.deepEqual(readSavedHeader(html), {
    url,
    userscripts: ['Name -- with dashes 1.0', 'Ends early --&gt; not'],
  });
});
