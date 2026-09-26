// ==UserScript==
// @name        SourceMonkey example: Hash matching: @include without the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Demonstrates how @include without the hash treats a URL fragment (#hash).
// @include     *://*/headers-match-hash/headers-match-hash.html
// @include     file:///*/headers-match-hash/headers-match-hash.html
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  const li = document.createElement('li');
  li.dataset.script = 'include-exact';
  // Its rules, less the file:// copy, to set beside the URL above.
  li.textContent = '@include *://*/headers-match-hash/headers-match-hash.html';
  document.getElementById('log').appendChild(li);
})();
