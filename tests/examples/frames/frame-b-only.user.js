// ==UserScript==
// @name        SourceMonkey example: frames: Frame B only
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Matches only Frame B, so it runs on a page it doesn't match.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/frames/frame-b.html
// @match       *://*/*frames/frame-b.html
// @match       file:///*/frames/frame-b.html
// @run-at      document-end
// @grant       GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT = 'frame-b-only';
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
  GM_registerMenuCommand('Frame B only: mark ' + page, () => log('Menu command ran in ' + page));
})();
