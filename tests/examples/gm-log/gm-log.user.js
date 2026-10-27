// ==UserScript==
// @name        SourceMonkey example: gm-log: GM_log
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Demonstrate GM_log against several arg shapes.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/gm-log/gm-log.html
// @match       *://*/*gm-log/gm-log.html
// @match       file:///*/gm-log/gm-log.html
// @run-at      document-end
// @grant       GM_log
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  if (!status || !log) return;

  let counter = 0;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  function fire(args) {
    GM_log.apply(null, args);
    const printable = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(', ');
    append(`GM_log(${printable})  -- see DevTools console`);
  }

  document.getElementById('btn-simple').addEventListener('click', () => {
    fire(['hello from a userscript']);
  });

  document.getElementById('btn-multi').addEventListener('click', () => {
    counter += 1;
    fire(['tick at', new Date().toISOString(), 'count=', counter]);
  });

  document.getElementById('btn-object').addEventListener('click', () => {
    fire([{ type: 'demo', count: counter, when: Date.now() }]);
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    log.innerHTML = '';
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Click a button, then open DevTools to see the console output.';
})();
