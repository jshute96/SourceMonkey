// ==UserScript==
// @name        SourceMonkey example: @run-at document-idle
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Demonstrates @run-at document-idle (default; after load).
// @match       *://*/headers-run-at/headers-run-at.html
// @match       file:///*/headers-run-at/headers-run-at.html
// @run-at      document-idle
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  const log = document.getElementById('log');
  if (!log) return;

  const li = document.createElement('li');
  li.dataset.script = 'idle';
  li.textContent =
    `[document-idle] readyState=${document.readyState} body=<${document.body && document.body.tagName}>`;
  log.appendChild(li);

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
