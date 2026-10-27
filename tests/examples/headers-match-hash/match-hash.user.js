// ==UserScript==
// @name        SourceMonkey example: headers-match-hash: @match with the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.9
// @description @match names the page with #part. This doesn't match.*
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/headers-match-hash/headers-match-hash.html#part
// @match       *://*/*headers-match-hash/headers-match-hash.html#part
// @match       file:///*/headers-match-hash/headers-match-hash.html#part
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @match names the page with #part. This doesn't match.*
  //
  // * Violentmonkey matches it with #part.
  const li = document.createElement('li');
  li.dataset.script = 'match-hash';
  li.textContent = 'match-hash.user.js:    @match *://*/*headers-match-hash/headers-match-hash.html#part';
  document.getElementById('log').appendChild(li);
})();
