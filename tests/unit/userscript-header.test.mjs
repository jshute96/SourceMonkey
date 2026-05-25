// Tests for the userscript metadata-block parser in
// src/userscript-header.ts (compiled to dist/userscript-header.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHeader,
  getValue,
  getValues,
  getLocalized,
  hasTag,
  splitHeaderBody,
} from '../../dist/userscript-header.js';

const SAMPLE = `// ==UserScript==
// @name         Hello World
// @name:de      Hallo Welt
// @namespace    https://example.com/scripts
// @version      1.2.3
// @description  Greets the page
// @author       Jane
// @match        https://example.com/*
// @match        https://*.example.org/*
// @exclude      https://example.com/admin/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () { 'use strict'; })();
`;

test('parseHeader extracts tags in source order', () => {
  const h = parseHeader(SAMPLE);
  assert.ok(h);
  assert.equal(h.tags.length, 13);
  assert.deepEqual(h.tags[0], { tag: 'name', value: 'Hello World' });
  assert.deepEqual(h.tags[1], { tag: 'name', locale: 'de', value: 'Hallo Welt' });
  assert.deepEqual(h.tags[h.tags.length - 1], { tag: 'noframes', value: '' });
});

test('getValue returns first non-localized value', () => {
  const h = parseHeader(SAMPLE);
  assert.equal(getValue(h, 'name'), 'Hello World');
  assert.equal(getValue(h, 'version'), '1.2.3');
  assert.equal(getValue(h, 'run-at'), 'document-end');
  assert.equal(getValue(h, 'missing'), undefined);
});

test('getValue is case-insensitive on the tag name', () => {
  const h = parseHeader(SAMPLE);
  assert.equal(getValue(h, 'Name'), 'Hello World');
  assert.equal(getValue(h, 'RUN-AT'), 'document-end');
});

test('getValues returns every non-localized occurrence in order', () => {
  const h = parseHeader(SAMPLE);
  assert.deepEqual(getValues(h, 'match'), [
    'https://example.com/*',
    'https://*.example.org/*',
  ]);
  assert.deepEqual(getValues(h, 'grant'), ['GM_setValue', 'GM_getValue']);
  assert.deepEqual(getValues(h, 'never-there'), []);
});

test('getLocalized returns locale → value, excluding the unlocalized form', () => {
  const h = parseHeader(SAMPLE);
  assert.deepEqual(getLocalized(h, 'name'), { de: 'Hallo Welt' });
  assert.deepEqual(getLocalized(h, 'description'), {});
});

test('hasTag detects flag tags without values', () => {
  const h = parseHeader(SAMPLE);
  assert.equal(hasTag(h, 'noframes'), true);
  assert.equal(hasTag(h, 'unwrap'), false);
});

test('parseHeader returns null when the start marker is missing', () => {
  assert.equal(parseHeader('// @name Foo\n// ==/UserScript==\n'), null);
});

test('parseHeader returns null when the end marker is missing', () => {
  assert.equal(parseHeader('// ==UserScript==\n// @name Foo\n'), null);
});

test('parseHeader ignores non-tag lines inside the block', () => {
  const src = `// ==UserScript==
// just a regular comment, no @tag
// @name        Foo
//   not a tag either
// ==/UserScript==
`;
  const h = parseHeader(src);
  assert.deepEqual(h.tags, [{ tag: 'name', value: 'Foo' }]);
});

test('parseHeader stops at the end marker and ignores body tags', () => {
  const src = `// ==UserScript==
// @name Foo
// ==/UserScript==
// @name BodyImpostor
`;
  const h = parseHeader(src);
  assert.deepEqual(getValues(h, 'name'), ['Foo']);
});

test('parseHeader preserves multi-token values like @resource and @require', () => {
  const src = `// ==UserScript==
// @resource     myCSS https://example.com/style.css
// @require      https://cdn.example.com/lib.js#sha256=abc
// @description  Spaces   in    the    middle
// ==/UserScript==
`;
  const h = parseHeader(src);
  assert.equal(
    getValue(h, 'resource'),
    'myCSS https://example.com/style.css',
  );
  assert.equal(
    getValue(h, 'require'),
    'https://cdn.example.com/lib.js#sha256=abc',
  );
  assert.equal(getValue(h, 'description'), 'Spaces   in    the    middle');
});

test('parseHeader tolerates CRLF line endings', () => {
  const src = '// ==UserScript==\r\n// @name CRLF\r\n// ==/UserScript==\r\n';
  const h = parseHeader(src);
  assert.equal(getValue(h, 'name'), 'CRLF');
});

test('parseHeader tolerates extra whitespace around the markers', () => {
  const src = `  //   ==UserScript==
//    @name     Padded
   //   ==/UserScript==
`;
  const h = parseHeader(src);
  assert.equal(getValue(h, 'name'), 'Padded');
});

test('splitHeaderBody returns the raw block and the body', () => {
  const src = `// ==UserScript==
// @name Foo
// ==/UserScript==
(function () {
  console.log('hi');
})();
`;
  const result = splitHeaderBody(src);
  assert.equal(result.error, undefined);
  assert.equal(result.leadingText, '');
  assert.equal(
    result.headerText,
    '// ==UserScript==\n// @name Foo\n// ==/UserScript==',
  );
  assert.equal(result.bodyText, "(function () {\n  console.log('hi');\n})();\n");
});

test('splitHeaderBody captures text above the opening marker', () => {
  const src = `/* license blurb */
'use strict';
// ==UserScript==
// @name Foo
// ==/UserScript==
body();
`;
  const result = splitHeaderBody(src);
  assert.equal(result.error, undefined);
  assert.equal(result.leadingText, "/* license blurb */\n'use strict';\n");
  assert.equal(
    result.headerText,
    '// ==UserScript==\n// @name Foo\n// ==/UserScript==',
  );
  assert.equal(result.bodyText, 'body();\n');
});

test('splitHeaderBody flags missing opening marker', () => {
  const src = "console.log('no header');\n";
  const result = splitHeaderBody(src);
  assert.equal(result.error, 'no metadata block');
  assert.equal(result.leadingText, '');
  assert.equal(result.headerText, '');
  assert.equal(result.bodyText, src);
});

test('splitHeaderBody flags unterminated block', () => {
  const src = `// ==UserScript==
// @name Foo
console.log('forgot the close');
`;
  const result = splitHeaderBody(src);
  assert.equal(result.error, 'unterminated metadata block');
  assert.equal(result.leadingText, '');
  assert.equal(result.headerText, '');
  assert.equal(result.bodyText, src);
});

test('splitHeaderBody handles CRLF line endings', () => {
  const src =
    '// ==UserScript==\r\n// @name CRLF\r\n// ==/UserScript==\r\nbody();\r\n';
  const result = splitHeaderBody(src);
  assert.equal(result.error, undefined);
  assert.equal(result.leadingText, '');
  assert.equal(
    result.headerText,
    '// ==UserScript==\r\n// @name CRLF\r\n// ==/UserScript==',
  );
  assert.equal(result.bodyText, 'body();\r\n');
});

// Round-trip the parser and splitter across every line-terminator
// shape we might plausibly see on disk: LF (Unix/modern macOS),
// CRLF (Windows / lots of cross-platform editors), and bare CR
// (classic pre-OS-X Mac — vanishingly rare today but cheap to keep
// working as long as it costs us one regex character). Each shape is
// driven through a fixture with leading content, multiple tags, and
// a body so a regression in one component (e.g. line splitting in
// parseHeader, marker matching in splitHeaderBody) lights up.
for (const [name, nl] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
  const src =
    `'use strict';${nl}` +
    `// ==UserScript==${nl}` +
    `// @name        Newline ${name}${nl}` +
    `// @match       https://example.com/*${nl}` +
    `// @grant       none${nl}` +
    `// ==/UserScript==${nl}` +
    `body();${nl}`;

  test(`parseHeader handles ${name} line endings`, () => {
    const h = parseHeader(src);
    assert.ok(h, `${name}: parseHeader returned null`);
    assert.equal(getValue(h, 'name'), `Newline ${name}`);
    assert.deepEqual(getValues(h, 'match'), ['https://example.com/*']);
    assert.deepEqual(getValues(h, 'grant'), ['none']);
  });

  test(`splitHeaderBody handles ${name} line endings`, () => {
    const result = splitHeaderBody(src);
    assert.equal(result.error, undefined);
    // leadingText carries its own terminator so reassembling
    // (leadingText + headerText + nl + bodyText) yields the original.
    assert.equal(result.leadingText, `'use strict';${nl}`);
    assert.equal(
      result.headerText,
      `// ==UserScript==${nl}` +
      `// @name        Newline ${name}${nl}` +
      `// @match       https://example.com/*${nl}` +
      `// @grant       none${nl}` +
      `// ==/UserScript==`,
    );
    assert.equal(result.bodyText, `body();${nl}`);
    assert.equal(
      result.leadingText + result.headerText + nl + result.bodyText,
      src,
      `${name}: split + rejoin should reconstruct the source verbatim`,
    );
  });
}

test('splitHeaderBody returns empty bodyText when nothing follows the block', () => {
  const src = '// ==UserScript==\n// @name Alone\n// ==/UserScript==';
  const result = splitHeaderBody(src);
  assert.equal(result.error, undefined);
  assert.equal(result.leadingText, '');
  assert.equal(result.bodyText, '');
});
