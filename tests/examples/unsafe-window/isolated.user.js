// ==UserScript==
// @name        SourceMonkey example: unsafeWindow in the isolated world
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Negative case — @inject-into content pins the script to the isolated world, so unsafeWindow is not the page's.
// @match       *://*/unsafe-window/unsafe-window.html
// @match       file:///*/unsafe-window/unsafe-window.html
// @run-at      document-end
// @inject-into content
// @grant       unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  function log(variant, text) {
    const list = document.getElementById('log');
    if (!list) return;
    const li = document.createElement('li');
    li.dataset.script = variant;
    li.textContent = text;
    list.appendChild(li);
  }

  // `@inject-into content` is an explicit request for isolation, and it
  // wins over the unsafeWindow grant. There is nothing the manager can
  // do about that: property access on unsafeWindow is synchronous, and
  // Chrome exposes no synchronous channel from an isolated world into
  // the page's realm. So the binding stays, but it can only be the
  // isolated realm's own window.
  //
  // SourceMonkey flags this combination with a parse-time warning
  // (visible in the script's Log tab and the page console) so the
  // mismatch isn't silent. Other managers differ — that's exactly what
  // this variant is here to compare.
  log('isolated-read', `unsafeWindow.__PAGE_APP__ = ${String(unsafeWindow.__PAGE_APP__)}`);
  log('isolated-identity', `unsafeWindow === window: ${unsafeWindow === window}`);
})();
