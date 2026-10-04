// ==UserScript==
// @name        SourceMonkey example: GM_xmlhttpRequest with no @connect
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.1
// @description Demonstrates @connect with no lines: SourceMonkey asks before a request reaches another site.
// @match       *://*/xmlhttp-denied/xmlhttp-denied.html
// @match       file:///*/xmlhttp-denied/xmlhttp-denied.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // Localhost loopback: a request that the policy gate would
  // *send* fails with a network error, but a policy *block*
  // returns onerror before the SW ever calls fetch.
  const TARGET = 'http://127.0.0.1:1/';
  const log = document.getElementById('log');
  if (!log) return;

  function record(outcome, detail) {
    const li = document.createElement('li');
    li.dataset.script = 'no-connect';
    li.dataset.outcome = outcome;
    li.textContent = `[no-connect] ${outcome}: ${detail}`;
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
