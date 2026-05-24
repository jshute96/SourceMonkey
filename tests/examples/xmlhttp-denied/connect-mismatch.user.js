// ==UserScript==
// @name        SourceMonkey example: GM_xmlhttpRequest with @connect not covering target
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Demonstrates that @connect for the wrong host still blocks the request.
// @match       *://*/xmlhttp-denied/xmlhttp-denied.html
// @match       file:///*/xmlhttp-denied/xmlhttp-denied.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// @connect     somewhere.else.example.org
// ==/UserScript==

(function () {
  'use strict';

  const TARGET = 'http://127.0.0.1:1/';
  const log = document.getElementById('log');
  if (!log) return;

  function record(outcome, detail) {
    const li = document.createElement('li');
    li.dataset.script = 'connect-mismatch';
    li.dataset.outcome = outcome;
    li.textContent = `[connect-mismatch] ${outcome}: ${detail}`;
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
