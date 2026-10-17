// ==UserScript==
// @name        SourceMonkey example: headers-match-hash: @match with the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.8
// @description @match names the page with #part. This doesn't match.*
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
