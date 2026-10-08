// ==UserScript==
// @name        SourceMonkey example: @run-at context-menu
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.1
// @description Runs only when asked: each run adds a line to the page.
// @match       *://*/run-at-context-menu/run-at-context-menu.html
// @match       file:///*/run-at-context-menu/run-at-context-menu.html
// @run-at      context-menu
// @grant       GM_registerMenuCommand
// @grant       GM_getValue
// @grant       GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const runs = document.getElementById('runs');
  const log = document.getElementById('log');
  if (!status || !runs || !log) return;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = msg;
    log.prepend(li);
  }

  // This page's runs, kept on the list so Clear lines leaves the count
  // alone; the stored total counts every run anywhere, so it survives a
  // reload.
  const n = Number(runs.dataset.runs || 0) + 1;
  runs.dataset.runs = String(n);
  const total = GM_getValue('totalRuns', 0) + 1;
  GM_setValue('totalRuns', total);

  const line = document.createElement('li');
  line.textContent = 'Run ' + n + ' on this page (' + total + ' in all)';
  runs.appendChild(line);

  // A fixed id, so it stays one entry whatever happens to the others.
  GM_registerMenuCommand('Clear lines', () => {
    runs.textContent = '';
    append('cleared the lines');
  }, { id: 'clear-lines' });
  // No id: each run registers a new entry, and SourceMonkey drops the
  // last run's before this one starts.
  GM_registerMenuCommand('Say hello from run ' + n, () => {
    append('hello from run ' + n);
  });

  status.classList.add('ran');
  status.textContent = 'Userscript ran ' + n + (n === 1 ? ' time' : ' times') + ' on this page.';
})();
