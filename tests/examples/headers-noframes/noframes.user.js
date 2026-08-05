// ==UserScript==
// @name        SourceMonkey example: @noframes
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Runs only in the top-level document, never in a sub-frame.
// @match       *://*/headers-noframes/*.html
// @match       file:///*/headers-noframes/*.html
// @run-at      document-end
// @noframes
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  // The frame's URL matches this script's patterns too, so if this row
  // ever shows up in the embedded frame's log, `@noframes` was ignored.
  const inTopFrame = window.top === window;

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'noframes';
    li.dataset.frame = inTopFrame ? 'top' : 'sub';
    li.textContent =
      `[@noframes] ran in the ${inTopFrame ? 'top-level document' : 'embedded frame'} ` +
      `(${document.location.pathname})`;
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
