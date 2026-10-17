// ==UserScript==
// @name        SourceMonkey example: headers-match-hash: @include without the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.7
// @description @include names the page without a hash. This matches with no hash only.*
// @include     *://*/headers-match-hash/headers-match-hash.html
// @include     file:///*/headers-match-hash/headers-match-hash.html
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @include names the page without a hash. This matches with no hash only.*
  //
  // * Tampermonkey ignores the hash, so it matches there with any.
  const li = document.createElement('li');
  li.dataset.script = 'include-exact';
  li.textContent = 'include-exact.user.js: @include *://*/headers-match-hash/headers-match-hash.html';
  document.getElementById('log').appendChild(li);
})();
