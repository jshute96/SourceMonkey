// Unit tests for the SW-side GM_xmlhttpRequest helpers that are pure
// enough to exercise outside a browser. The fetch driver itself lives
// behind `runXhr` and is covered by tests/e2e/gm-xhr*.spec.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { resolveXhrUrl } from '../../dist/gm-xhr.js';

const PAGE = 'https://page.example/dir/index.html?q=1';

test('resolveXhrUrl: absolute URLs pass through untouched', () => {
  assert.equal(resolveXhrUrl('https://api.example/x', PAGE), 'https://api.example/x');
});

test('resolveXhrUrl: root-relative resolves against the page origin', () => {
  assert.equal(resolveXhrUrl('/api/x', PAGE), 'https://page.example/api/x');
});

test('resolveXhrUrl: path-relative resolves against the page directory', () => {
  assert.equal(resolveXhrUrl('data.json', PAGE), 'https://page.example/dir/data.json');
  assert.equal(resolveXhrUrl('./data.json', PAGE), 'https://page.example/dir/data.json');
  assert.equal(resolveXhrUrl('../up.json', PAGE), 'https://page.example/up.json');
});

test('resolveXhrUrl: protocol-relative takes the page scheme', () => {
  assert.equal(resolveXhrUrl('//cdn.example/x.js', PAGE), 'https://cdn.example/x.js');
});

test('resolveXhrUrl: no page URL leaves the value alone', () => {
  // Nothing to resolve against — the caller's own error handling
  // (`decideConnect` → "invalid URL") still applies.
  assert.equal(resolveXhrUrl('/api/x', undefined), '/api/x');
});

test('resolveXhrUrl: an unresolvable pair is returned unchanged', () => {
  assert.equal(resolveXhrUrl('/api/x', 'not-a-url'), '/api/x');
});

// An `about:blank` / `srcdoc` frame reports a document URL that is no
// base at all, while `sender.origin` still carries the origin it
// inherited. See `requestingOrigin` in background.ts.
test('resolveXhrUrl: root-relative falls back to the page origin', () => {
  assert.equal(
    resolveXhrUrl('/api/x', 'about:blank', 'https://page.example'),
    'https://page.example/api/x',
  );
});

test('resolveXhrUrl: document-relative does NOT fall back to the origin', () => {
  // `/data.json` is a different request from the `dir/data.json` the
  // script asked for, so reporting an unusable URL beats guessing.
  assert.equal(resolveXhrUrl('data.json', 'about:blank', 'https://page.example'), 'data.json');
});

test('resolveXhrUrl: the document URL wins when it is usable', () => {
  assert.equal(
    resolveXhrUrl('/api/x', PAGE, 'https://other.example'),
    'https://page.example/api/x',
  );
});
