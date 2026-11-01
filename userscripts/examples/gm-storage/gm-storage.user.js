// ==UserScript==
// @name        SourceMonkey example: gm-storage: GM storage
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.0
// @description Set/get/delete/list per-script GM storage values via a form, one key or many at once.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/userscripts/examples/gm-storage/gm-storage.html
// @match       *://*/*gm-storage/gm-storage.html
// @match       file:///*/gm-storage/gm-storage.html
// @run-at      document-end
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_listValues
// @grant       GM_setValues
// @grant       GM_getValues
// @grant       GM_deleteValues
// @grant       GM_addValueChangeListener
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const keyInput = document.getElementById('key');
  const valueInput = document.getElementById('value');
  const bulkInput = document.getElementById('bulk');
  const out = document.getElementById('output');
  const changes = document.getElementById('changes');
  if (!status || !keyInput || !valueInput || !bulkInput || !out || !changes) return;

  function render(label, value) {
    const body = (typeof value === 'string')
      ? value
      : JSON.stringify(value, null, 2);
    out.textContent = `${label}\n${body}`;
  }

  // One value-change listener per key the form has used, so the
  // change log shows each call the manager makes for each key.
  const listening = new Set();
  function listen(keys) {
    for (const k of keys) {
      if (listening.has(k)) continue;
      listening.add(k);
      GM_addValueChangeListener(k, (key, oldValue, newValue, remote) => {
        if (changes.textContent === '(none yet)') changes.textContent = '';
        changes.textContent +=
          `${key}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}${remote ? ' (remote)' : ''}\n`;
      });
    }
  }

  // The bulk field as JSON, or an error shown in the output.
  function parseBulk() {
    try { return { ok: true, value: JSON.parse(bulkInput.value) }; } catch (e) {
      render('error', `bulk input is not JSON: ${e.message}`);
      return { ok: false };
    }
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
    listen([k]);
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
    listen([k]);
    GM_deleteValue(k);
    render(`deleteValue(${JSON.stringify(k)})`, '(done)');
  });

  document.getElementById('btn-list').addEventListener('click', () => {
    const keys = GM_listValues();
    render('listValues() ->', keys);
  });

  document.getElementById('btn-set-many').addEventListener('click', () => {
    const p = parseBulk();
    if (!p.ok) return;
    if (!p.value || typeof p.value !== 'object' || Array.isArray(p.value)) {
      render('error', 'GM_setValues needs an object like {"a": 1, "b": 2}');
      return;
    }
    listen(Object.keys(p.value));
    GM_setValues(p.value);
    render('setValues(...) =>', p.value);
  });

  document.getElementById('btn-get-many').addEventListener('click', () => {
    // Empty asks for all values, which Violentmonkey doesn't support.
    const p = bulkInput.value.trim() ? parseBulk() : { ok: true, value: undefined };
    if (!p.ok) return;
    const label = `getValues(${p.value === undefined ? '' : JSON.stringify(p.value)})`;
    try {
      render(`${label} ->`, GM_getValues(p.value));
    } catch (e) {
      render(`${label} threw`, String(e));
    }
  });

  document.getElementById('btn-delete-many').addEventListener('click', () => {
    const p = parseBulk();
    if (!p.ok) return;
    if (!Array.isArray(p.value)) {
      render('error', 'GM_deleteValues needs an array like ["a", "b"]');
      return;
    }
    listen(p.value.map(String));
    GM_deleteValues(p.value);
    render(`deleteValues(${JSON.stringify(p.value)})`, '(done)');
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Enter a key and value, then click a button.';
})();
