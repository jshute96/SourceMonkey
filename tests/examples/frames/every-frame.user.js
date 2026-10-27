// ==UserScript==
// @name        SourceMonkey example: frames: every frame
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.4
// @description Runs in the page and each of its frames, sharing a counter across them.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/frames/frames.html
// @match       *://*/*frames/frames.html
// @match       *://*/*frames/frame-a.html
// @match       *://*/*frames/frame-b.html
// @match       *://*/*frames/frame-nested.html
// @match       file:///*/frames/*.html
// @run-at      document-end
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_addValueChangeListener
// @grant       GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT = 'every-frame';
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

  // One counter for every document the script runs in: a click in any
  // of them shows in all, through the value-change listener.
  const count = document.getElementById('count');
  const show = (n) => { if (count) count.textContent = String(n); };
  show(GM_getValue('count', 0));
  GM_addValueChangeListener('count', (_key, _old, value) => show(value));
  const button = document.createElement('button');
  button.id = 'btn-count';
  button.textContent = 'Count';
  button.addEventListener('click', () => {
    const next = GM_getValue('count', 0) + 1;
    GM_setValue('count', next);
    show(next);
  });
  document.getElementById('buttons')?.append(button);

  GM_registerMenuCommand('Every frame: mark ' + page, () => log('Menu command ran in ' + page));
  // The same caption in every document: the manager shows it once, and
  // picking it runs it in each of them.
  GM_registerMenuCommand('Every frame: mark all', () => log('Mark all ran in ' + page));
})();
