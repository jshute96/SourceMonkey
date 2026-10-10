// ==UserScript==
// @name        SourceMonkey example: frames: top frame only
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.1
// @description Matches the page and its frames, but @noframes keeps it to the top frame.
// @match       *://*/frames/frames.html
// @match       *://*/frames/frame-a.html
// @match       *://*/frames/frame-b.html
// @match       *://*/frames/frame-nested.html
// @match       file:///*/frames/*.html
// @noframes
// @run-at      document-end
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT = 'top-only';
  // A row in this document's log, tagged with the script, for the spec.
  function log(text) {
    const list = document.getElementById('log');
    if (!list) return;
    const li = document.createElement('li');
    li.dataset.script = SCRIPT;
    li.textContent = '[' + SCRIPT + '] ' + text;
    list.append(li);
  }

  const page = document.body.dataset.page;
  const where = window.top === window.self ? 'the top frame' : 'a frame';

  log('Ran in ' + page + ' (' + where + ')');
})();
