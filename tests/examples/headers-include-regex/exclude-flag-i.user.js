// ==UserScript==
// @name        SourceMonkey example: headers-include-regex: @exclude with /i flag
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.7
// @description @match names this page, and so does an @exclude regex with an i flag after it. This matches.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/headers-include-regex/headers-include-regex.html
// @match       *://*/*headers-include-regex/headers-include-regex.html
// @match       file:///*/headers-include-regex/headers-include-regex.html
// @exclude     /HEADERS-INCLUDE-REGEX\.HTML/i
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @match names this page, and so does an @exclude regex with an i flag after
  // it. This matches.
  const li = document.createElement('li');
  li.dataset.script = 'exclude-flag-i';
  li.textContent = 'exclude-flag-i.user.js: @match *://*/*headers-include-regex/headers-include-regex.html + @exclude /HEADERS-INCLUDE-REGEX\\.HTML/i';
  document.getElementById('log').appendChild(li);
})();
