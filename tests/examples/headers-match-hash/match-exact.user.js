// ==UserScript==
// @name        SourceMonkey example: headers-match-hash: @match without the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.8
// @description @match names the page without a hash. This matches, with any hash or none.
// @match       *://*/*headers-match-hash/headers-match-hash.html
// @match       file:///*/headers-match-hash/headers-match-hash.html
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @match names the page without a hash. This matches, with any hash or none.
  const li = document.createElement('li');
  li.dataset.script = 'match-exact';
  li.textContent = 'match-exact.user.js:   @match *://*/*headers-match-hash/headers-match-hash.html';
  document.getElementById('log').appendChild(li);
})();
