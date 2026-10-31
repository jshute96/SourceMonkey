// ==UserScript==
// @name        SourceMonkey example: headers-include-regex: /i flag
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.6
// @description A regex @include with an i flag after it. This doesn't match.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @include     /HEADERS-INCLUDE-REGEX\.HTML/i
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // A regex @include with an i flag after it. This doesn't match.
  const li = document.createElement('li');
  li.dataset.script = 'regex-flag-i';
  li.textContent = 'regex-flag-i.user.js:   @include /HEADERS-INCLUDE-REGEX\\.HTML/i';
  document.getElementById('log').appendChild(li);
})();
