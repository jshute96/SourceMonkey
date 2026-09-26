// ==UserScript==
// @name        SourceMonkey example: Hash matching: @match with the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Demonstrates how @match with the hash treats a URL fragment (#hash).
// @match       *://*/headers-match-hash/headers-match-hash.html#part
// @match       file:///*/headers-match-hash/headers-match-hash.html#part
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  const li = document.createElement('li');
  li.dataset.script = 'match-hash';
  // Its rules, less the file:// copy, to set beside the URL above.
  li.textContent = '@match *://*/headers-match-hash/headers-match-hash.html#part';
  document.getElementById('log').appendChild(li);
})();
