// ==UserScript==
// @name        SourceMonkey example: require-scope: @require in the content (USER_SCRIPT) world
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description The same @require'd library reaches an isolated-world script, alongside its GM_* bindings.
// @match       *://*/*require-scope/require-scope.html
// @match       file:///*/require-scope/require-scope.html
// @run-at      document-end
// @inject-into content
// @grant       GM_info
// @require     https://jshute96.github.io/SourceMonkey/tests/examples/require-scope/lib.js
// ==/UserScript==

(function () {
  'use strict';

  // USER_SCRIPT world: isolated `window`, and the GM_* bindings the
  // script granted are emitted into the same scope as the require.
  // That ordering matters — the bindings come first, so library
  // top-level code could call them too.
  const results = {
    world: 'content',
    fromClass: new RequireScopeGreeter('content').greet(),
    fromConst: REQUIRE_SCOPE_CONST,
    fromFunction: requireScopeFn('content'),
    // The GM binding and the require's bindings coexist in one scope
    // without colliding.
    gmInfoName: typeof GM_info === 'object' ? GM_info.script.name : '(no GM_info)',
    // Isolated world: the page's global is not visible here, which is
    // what distinguishes this script from its page-world sibling.
    seesPageGlobal: window.__SM_REQUIRE_SCOPE_PAGE_MARKER__ ?? '(not visible)',
  };

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'content';
    li.textContent = `[content world] ${JSON.stringify(results)}`;
    log.appendChild(li);
  }

  // Shared helper from lib.js — counts the rows both scripts append,
  // since the two run in different worlds and can't share a counter.
  requireScopeUpdateStatus();
})();
