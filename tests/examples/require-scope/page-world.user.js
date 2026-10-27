// ==UserScript==
// @name        SourceMonkey example: require-scope: @require in the page (MAIN) world
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.4
// @description A @require'd library's top-level class/const/function reach a MAIN-world script.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/require-scope/require-scope.html
// @match       *://*/*require-scope/require-scope.html
// @match       file:///*/require-scope/require-scope.html
// @run-at      document-end
// @inject-into page
// @grant       none
// @require     https://jshute96.github.io/SourceMonkey/tests/examples/require-scope/lib.js
// ==/UserScript==

(function () {
  'use strict';

  // MAIN world: we share `window` with the page and get no GM_*
  // bindings beyond GM_info. The require still has to reach us — the
  // concatenation happens per script, independently of which world
  // the script lands in.
  const results = {
    world: 'page',
    fromClass: new RequireScopeGreeter('page').greet(),
    fromConst: REQUIRE_SCOPE_CONST,
    fromFunction: requireScopeFn('page'),
    // A MAIN-world script shares the page's global object, so a
    // require's top-level bindings must NOT land there — they're
    // locals of the script's wrap function. If this reports 'yes' the
    // library is leaking into the page.
    leakedToWindow: typeof window.REQUIRE_SCOPE_CONST === 'undefined' ? 'no' : 'yes',
    // ...and we really are in the page's world, not an isolated one.
    seesPageGlobal: window.__SM_REQUIRE_SCOPE_PAGE_MARKER__ ?? '(not visible)',
  };

  window.__SM_REQUIRE_SCOPE_FROM_PAGE__ = results;

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'page';
    li.textContent = `[page world] ${JSON.stringify(results)}`;
    log.appendChild(li);
  }

  // Shared helper from lib.js — counts the rows both scripts append,
  // since the two run in different worlds and can't share a counter.
  requireScopeUpdateStatus();
})();
