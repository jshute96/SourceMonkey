// ==UserScript==
// @name        SourceMonkey example: headers-match-hash: @match plus a regex @include
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.9
// @description @match names the page without a hash, plus a regex @include that matches nothing. This matches, with any hash or none.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/headers-match-hash/headers-match-hash.html
// @match       *://*/*headers-match-hash/headers-match-hash.html
// @match       file:///*/headers-match-hash/headers-match-hash.html
// @include     /nomatch-xyz/
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @match names the page without a hash, plus a regex @include that matches
  // nothing. This matches, with any hash or none.
  //
  // The regex makes SourceMonkey check the rules again in the page, and that
  // check has to ignore the hash too.
  const li = document.createElement('li');
  li.dataset.script = 'match-regex';
  li.textContent = 'match-regex.user.js:   @match *://*/*headers-match-hash/headers-match-hash.html + @include /nomatch-xyz/';
  document.getElementById('log').appendChild(li);
})();
