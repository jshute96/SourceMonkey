// ==UserScript==
// @name        SourceMonkey example: headers-include-regex: uppercase regex
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.6
// @description An uppercase regex @include, on a lowercase URL. This matches.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @include     /HEADERS-INCLUDE-REGEX\.HTML/
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // An uppercase regex @include, on a lowercase URL. This matches.
  const li = document.createElement('li');
  li.dataset.script = 'regex-case';
  li.textContent = 'regex-case.user.js:     @include /HEADERS-INCLUDE-REGEX\\.HTML/';
  document.getElementById('log').appendChild(li);
})();
