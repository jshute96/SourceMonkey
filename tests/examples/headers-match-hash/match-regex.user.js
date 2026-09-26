// ==UserScript==
// @name        SourceMonkey example: Hash matching: @match plus a regex @include
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Demonstrates how @match plus a regex @include treats a URL fragment (#hash).
// @match       *://*/headers-match-hash/headers-match-hash.html
// @match       file:///*/headers-match-hash/headers-match-hash.html
// @include     /nomatch-xyz/
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // The regex @include matches nothing on purpose: a regex rule makes
  // SourceMonkey recheck the URL in the page, which is the case under
  // test. The @match is what lets it run.
  const li = document.createElement('li');
  li.dataset.script = 'match-regex';
  // Its rules, less the file:// copy, to set beside the URL above.
  li.textContent = '@match *://*/headers-match-hash/headers-match-hash.html + @include /nomatch-xyz/';
  document.getElementById('log').appendChild(li);
})();
