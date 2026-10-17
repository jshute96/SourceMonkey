// ==UserScript==
// @name        SourceMonkey example: gm-storage: GM storage
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Set/get/delete/list per-script GM storage values via a form.
// @match       *://*/*gm-storage/gm-storage.html
// @match       file:///*/gm-storage/gm-storage.html
// @run-at      document-end
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_listValues
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const keyInput = document.getElementById('key');
  const valueInput = document.getElementById('value');
  const out = document.getElementById('output');
  if (!status || !keyInput || !valueInput || !out) return;

  function render(label, value) {
    const body = (typeof value === 'string')
      ? value
      : JSON.stringify(value, null, 2);
    out.textContent = `${label}\n${body}`;
  }

  function parseValue(raw) {
    // Try JSON first so callers can store numbers/booleans/objects;
    // fall back to the raw string so "hello" without quotes still works.
    try { return JSON.parse(raw); } catch { return raw; }
  }

  document.getElementById('btn-set').addEventListener('click', () => {
    const k = keyInput.value;
    if (!k) { render('error', 'key is required'); return; }
    const v = parseValue(valueInput.value);
    GM_setValue(k, v);
    render(`setValue(${JSON.stringify(k)}, ...) =>`, v);
  });

  document.getElementById('btn-get').addEventListener('click', () => {
    const k = keyInput.value;
    if (!k) { render('error', 'key is required'); return; }
    const got = GM_getValue(k, '(undefined)');
    render(`getValue(${JSON.stringify(k)}) ->`, got);
  });

  document.getElementById('btn-delete').addEventListener('click', () => {
    const k = keyInput.value;
    if (!k) { render('error', 'key is required'); return; }
    GM_deleteValue(k);
    render(`deleteValue(${JSON.stringify(k)})`, '(done)');
  });

  document.getElementById('btn-list').addEventListener('click', () => {
    const keys = GM_listValues();
    render('listValues() ->', keys);
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Enter a key and value, then click a button.';
})();
