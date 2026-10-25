// ==UserScript==
// @name        SourceMonkey example: require-scope: relative @require paths
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Loads two @require libraries by relative path, in order.
// @match       *://*/*require-scope/require-scope.html
// @match       file:///*/require-scope/require-scope.html
// @run-at      document-end
// @grant       none
// @require     ./first.js
// @require     ./second.js
// ==/UserScript==

// Relative `@require` paths resolve against the script's own URL. That
// works in SourceMonkey, and in Violentmonkey, which resolves them
// against the URL it installed the script from. Tampermonkey takes
// absolute URLs only.
//
// The two libraries also pin their order: second.js reads first.js's
// `const` as it loads, so swapping the two lines above throws a
// ReferenceError before this body runs.
(function () {
  'use strict';

  const status = document.getElementById('relativeStatus');
  if (!status) return;
  status.textContent = `Relative @require ran: ${RELATIVE_SECOND}`;
  status.classList.add('ran');
})();
