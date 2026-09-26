// ==UserScript==
// @name        SourceMonkey example: Hash matching: @include with the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Demonstrates how @include with the hash treats a URL fragment (#hash).
// @include     *://*/headers-match-hash/headers-match-hash.html#part
// @include     file:///*/headers-match-hash/headers-match-hash.html#part
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  const li = document.createElement('li');
  li.dataset.script = 'include-hash';
  // Its rules, less the file:// copy, to set beside the URL above.
  li.textContent = '@include *://*/headers-match-hash/headers-match-hash.html#part';
  document.getElementById('log').appendChild(li);
})();
