// ==UserScript==
// @name        SourceMonkey example: GM value-change listeners
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Register/remove GM_addValueChangeListener callbacks.
// @match       *://*/gm-value-listeners/gm-value-listeners.html
// @match       file:///*/gm-value-listeners/gm-value-listeners.html
// @run-at      document-end
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_addValueChangeListener
// @grant       GM_removeValueChangeListener
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const valueEl = document.getElementById('value');
  const log = document.getElementById('log');
  if (!status || !valueEl || !log) return;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  function fmt(v) {
    if (v === undefined) return '(undefined)';
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function makeListener(label) {
    return (name, oldVal, newVal, remote) => {
      append(`${label} fired: name=${name} old=${fmt(oldVal)} new=${fmt(newVal)} remote=${remote}`);
    };
  }

  const id1 = GM_addValueChangeListener('demo-key', makeListener('listener 1'));
  const id2 = GM_addValueChangeListener('demo-key', makeListener('listener 2'));
  append(`registered: id1=${fmt(id1)}, id2=${fmt(id2)}`);

  document.getElementById('btn-set').addEventListener('click', () => {
    let parsed;
    try { parsed = JSON.parse(valueEl.value); } catch { parsed = valueEl.value; }
    append(`-> GM_setValue('demo-key', ${fmt(parsed)})`);
    GM_setValue('demo-key', parsed);
  });

  document.getElementById('btn-delete').addEventListener('click', () => {
    append(`-> GM_deleteValue('demo-key')`);
    GM_deleteValue('demo-key');
  });

  document.getElementById('btn-remove1').addEventListener('click', () => {
    GM_removeValueChangeListener(id1);
    append(`removed listener 1 (id=${fmt(id1)})`);
  });

  document.getElementById('btn-remove2').addEventListener('click', () => {
    GM_removeValueChangeListener(id2);
    append(`removed listener 2 (id=${fmt(id2)})`);
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Two listeners registered on demo-key. Set a value to fire them.';
})();
