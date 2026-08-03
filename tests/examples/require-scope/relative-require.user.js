// ==UserScript==
// @name        SourceMonkey example: relative @require (SourceMonkey only)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description A relative @require path resolved against the script's own URL — a SourceMonkey extension no other manager implements.
// @match       *://*/require-scope/require-scope.html
// @match       file:///*/require-scope/require-scope.html
// @run-at      document-end
// @inject-into content
// @grant       none
// @require     ./lib.js
// @require     ./relative-lib.js
// ==/UserScript==

(function () {
  'use strict';

  // Deliberately NOT portable. Relative `@require` paths resolve
  // against this script's own URL, which TM/VM/GM don't implement —
  // they take absolute URLs only. Under those managers this script
  // either fails to install or installs and then throws on the first
  // missing binding, so it appends no row and the status line settles
  // one short. That gap is the point: it's what makes the example
  // show the SourceMonkey extension rather than just assert it.
  //
  // Two requires, so this also pins the concatenation ORDER: they're
  // prepended to the body in header order, and both land in the same
  // scope as each other and as the body.
  const results = {
    world: 'content',
    // From lib.js — the same file the portable scripts pull in by
    // absolute URL. Reaching it by relative path proves both spellings
    // resolve to one library.
    fromSharedConst: REQUIRE_SCOPE_CONST,
    fromSharedClass: new RequireScopeGreeter('relative-require').greet(),
    // From relative-lib.js — reachable ONLY by the relative ref.
    fromRelativeConst: REQUIRE_SCOPE_RELATIVE_CONST,
    fromRelativeFunction: requireScopeRelativeFn('relative-require'),
  };

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'relative';
    li.textContent = `[relative require] ${JSON.stringify(results)}`;
    log.appendChild(li);
  }

  // Shared helper from lib.js — counts the rows every script appends,
  // since they run in different worlds and can't share a counter.
  requireScopeUpdateStatus();
})();
