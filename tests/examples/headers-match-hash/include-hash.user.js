// ==UserScript==
// @name        SourceMonkey example: Hash matching: @include with the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.6
// @description @include names the page with #part. This matches with #part only.*
// @include     *://*/headers-match-hash/headers-match-hash.html#part
// @include     file:///*/headers-match-hash/headers-match-hash.html#part
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @include names the page with #part. This matches with #part only.*
  //
  // * Tampermonkey ignores the hash, so it never matches there.
  const li = document.createElement('li');
  li.dataset.script = 'include-hash';
  li.textContent = 'include-hash.user.js:  @include *://*/headers-match-hash/headers-match-hash.html#part';
  document.getElementById('log').appendChild(li);
})();
