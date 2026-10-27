// ==UserScript==
// @name        SourceMonkey example: headers-include-regex: uppercase glob
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.7
// @description An uppercase glob @include, on a lowercase URL. This matches.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @include     *HEADERS-INCLUDE-REGEX.HTML*
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // An uppercase glob @include, on a lowercase URL. This matches.
  const li = document.createElement('li');
  li.dataset.script = 'glob-case';
  li.textContent = 'glob-case.user.js:      @include *HEADERS-INCLUDE-REGEX.HTML*';
  document.getElementById('log').appendChild(li);
})();
