// ==UserScript==
// @name        SourceMonkey example: GM storage
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.0
// @description Explore the GM storage APIs: preset calls, editable argument forms, and a log of every call.
// @match       *://*/gm-storage/gm-storage.html
// @match       file:///*/gm-storage/gm-storage.html
// @run-at      document-end
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_listValues
// @require     ./api-explorer.js
// ==/UserScript==

// The @require is a relative path — a SourceMonkey extension, so this
// example is SM-only. See tests/examples/README.md.

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  if (!status) return;

  // Every box quotes its key the same way, and `undefined` has to stay
  // distinguishable from the string "undefined" in a log about storage.
  const q = (v) => (v === undefined ? '' : JSON.stringify(v));

  ApiExplorer.create({
    mount: '#explorer',
    examples: '#examples',
    log: '#log',
    boxes: [
      {
        id: 'set',
        signature: 'GM_setValue(key, value)',
        render: (a) => `GM_setValue(${q(a.key)}, ${q(a.value)})`,
        fields: [
          { name: 'key', kind: 'string', required: true, placeholder: 'my-key' },
          { name: 'value', kind: 'jsonOrString', required: true,
            placeholder: '"foo" / 42 / {"a":1} / plain text',
            hint: 'Parsed as JSON when it parses, stored verbatim when it doesn’t.' },
        ],
        call: (a) => GM_setValue(a.key, a.value),
        presets: [
          { id: 'set-string', label: 'a string',
            args: { key: 'demo-key', value: 'hello-world' },
            note: 'stores the text verbatim' },
          { id: 'set-number', label: 'a number',
            args: { key: 'demo-number', value: 42 },
            note: 'stores a real number, not "42"' },
          { id: 'set-object', label: 'an object',
            args: { key: 'demo-object', value: { a: 1, b: [true, null] } },
            note: 'values are structured, not stringified by the caller' },
        ],
      },
      {
        id: 'get',
        signature: 'GM_getValue(key, defaultValue?)',
        // The default is genuinely optional, and whether a manager
        // returns `undefined` or the default for a missing key is one
        // of the things this page is for — so don't render an argument
        // that wasn't passed.
        render: (a) => (a.defaultValue === undefined
          ? `GM_getValue(${q(a.key)})`
          : `GM_getValue(${q(a.key)}, ${q(a.defaultValue)})`),
        fields: [
          { name: 'key', kind: 'string', required: true, placeholder: 'my-key' },
          { name: 'defaultValue', kind: 'jsonOrString', label: 'defaultValue (optional)',
            placeholder: 'returned when the key is absent' },
        ],
        call: (a) => ('defaultValue' in a
          ? GM_getValue(a.key, a.defaultValue)
          : GM_getValue(a.key)),
        presets: [
          { id: 'get-string', label: 'read demo-key',
            args: { key: 'demo-key' },
            note: 'reads back whatever GM_setValue stored' },
          { id: 'get-missing', label: 'missing key, no default',
            args: { key: 'no-such-key' },
            note: 'returns undefined' },
          { id: 'get-default', label: 'missing key, with default',
            args: { key: 'no-such-key', defaultValue: '(fallback)' },
            note: 'returns the default instead of undefined' },
        ],
      },
      {
        id: 'delete',
        signature: 'GM_deleteValue(key)',
        render: (a) => `GM_deleteValue(${q(a.key)})`,
        fields: [
          { name: 'key', kind: 'string', required: true, placeholder: 'my-key' },
        ],
        call: (a) => GM_deleteValue(a.key),
        presets: [
          { id: 'delete-key', label: 'delete demo-key',
            args: { key: 'demo-key' },
            note: 'deleting an absent key is not an error' },
        ],
      },
      {
        id: 'list',
        signature: 'GM_listValues()',
        note: 'Takes no arguments — Submit runs it.',
        render: () => 'GM_listValues()',
        fields: [],
        call: () => GM_listValues(),
        presets: [
          { id: 'list', label: 'list every key', args: {},
            note: 'only this script’s keys; storage is per-userscript' },
        ],
      },
    ],
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Click a preset, or fill in a form and submit.';
})();
