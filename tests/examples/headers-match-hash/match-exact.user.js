// ==UserScript==
// @name        SourceMonkey example: Hash matching: @match without the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Demonstrates how @match without the hash treats a URL fragment (#hash).
// @match       *://*/headers-match-hash/headers-match-hash.html
// @match       file:///*/headers-match-hash/headers-match-hash.html
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  const li = document.createElement('li');
  li.dataset.script = 'match-exact';
  // Its rules, less the file:// copy, to set beside the URL above.
  li.textContent = '@match *://*/headers-match-hash/headers-match-hash.html';
  document.getElementById('log').appendChild(li);
})();
