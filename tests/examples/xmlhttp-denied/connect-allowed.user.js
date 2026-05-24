// ==UserScript==
// @name        SourceMonkey example: GM_xmlhttpRequest with @connect covering target
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Demonstrates that @connect 127.0.0.1 lets the request through.
// @match       *://*/xmlhttp-denied/xmlhttp-denied.html
// @match       file:///*/xmlhttp-denied/xmlhttp-denied.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// @connect     127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  const TARGET = 'http://127.0.0.1:1/';
  const log = document.getElementById('log');
  if (!log) return;

  function record(outcome, detail) {
    const li = document.createElement('li');
    li.dataset.script = 'connect-allowed';
    li.dataset.outcome = outcome;
    li.textContent = `[connect-allowed] ${outcome}: ${detail}`;
    log.appendChild(li);
    const status = document.getElementById('runStatus');
    if (status) {
      status.classList.add('ran');
      status.textContent = 'At least one userscript ran. See log below.';
    }
  }

  GM_xmlhttpRequest({
    method: 'GET',
    url: TARGET,
    timeout: 3000,
    onload(res) { record('onload', `status=${res.status}`); },
    onerror(e) { record('onerror', (e && e.error) || String(e)); },
    ontimeout() { record('ontimeout', 'timed out'); },
  });
})();
