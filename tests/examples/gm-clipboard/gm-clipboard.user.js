// ==UserScript==
// @name        SourceMonkey example: GM_setClipboard
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Copy a text value to the system clipboard.
// @match       *://*/gm-clipboard/gm-clipboard.html
// @match       file:///*/gm-clipboard/gm-clipboard.html
// @run-at      document-end
// @grant       GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const text = document.getElementById('text');
  const log = document.getElementById('log');
  if (!status || !text || !log) return;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  document.getElementById('btn-copy').addEventListener('click', () => {
    const value = text.value;
    append(`-> GM_setClipboard(${JSON.stringify(value)})`);
    try {
      // Some managers return a Promise; others return undefined.
      // Promise.resolve normalizes both cases.
      Promise.resolve(GM_setClipboard(value)).then(
        () => append('   resolved -- paste somewhere to verify'),
        (e) => append(`   rejected: ${(e && e.message) || e}`),
      );
    } catch (e) {
      append(`   threw: ${(e && e.message) || e}`);
    }
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Enter text and click GM_setClipboard, then paste to verify.';
})();
