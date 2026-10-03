// ==UserScript==
// @name        SourceMonkey example: Include regex: uppercase glob
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.4
// @description An uppercase glob @include, on a lowercase URL. This doesn't match.*
// @include     *HEADERS-INCLUDE-REGEX.HTML*
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // An uppercase glob @include, on a lowercase URL. This doesn't match.*
  //
  // * Tampermonkey and Violentmonkey ignore case in globs, so it matches
  // there.
  const li = document.createElement('li');
  li.dataset.script = 'glob-case';
  li.textContent = 'glob-case.user.js:      @include *HEADERS-INCLUDE-REGEX.HTML*';
  document.getElementById('log').appendChild(li);
})();
