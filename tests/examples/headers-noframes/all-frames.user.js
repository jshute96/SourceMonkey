// ==UserScript==
// @name        SourceMonkey example: frames (no @noframes)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Default frame behavior — runs in the top document and in every matching sub-frame.
// @match       *://*/headers-noframes/*.html
// @match       file:///*/headers-noframes/*.html
// @run-at      document-end
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  // Each frame is a separate document with a separate copy of this
  // script, so `window.top === window` is what tells us where we are.
  const inTopFrame = window.top === window;

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'all-frames';
    li.dataset.frame = inTopFrame ? 'top' : 'sub';
    li.textContent =
      `[no @noframes] ran in the ${inTopFrame ? 'top-level document' : 'embedded frame'} ` +
      `(${document.location.pathname})`;
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
