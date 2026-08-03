// ==UserScript==
// @name        SourceMonkey example: @require in the page (MAIN) world
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.0
// @description A @require'd library's top-level class/const/function reach a MAIN-world script.
// @match       *://*/require-scope/require-scope.html
// @match       file:///*/require-scope/require-scope.html
// @run-at      document-end
// @inject-into page
// @grant       none
// @require     https://raw.githubusercontent.com/jshute96/SourceMonkey/main/tests/examples/require-scope/lib.js
// ==/UserScript==

(function () {
  'use strict';

  // The `@require` above is an ABSOLUTE URL so this script is portable
  // to TM/VM/GM, which don't implement relative refs. It points at
  // this repo's `main` branch, so a foreign manager fetches whatever
  // `main` has — edit `lib.js` and the fetched copy only catches up
  // once the change merges.
  //
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
