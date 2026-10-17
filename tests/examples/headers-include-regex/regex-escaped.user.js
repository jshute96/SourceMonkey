// ==UserScript==
// @name        SourceMonkey example: headers-include-regex: escaped slashes
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.5
// @description A regex @include with escaped slashes (\/). This matches.
// @include     /headers-include-regex\/headers-include-regex\.html/
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // A regex @include with escaped slashes (\/). This matches.
  const li = document.createElement('li');
  li.dataset.script = 'regex-escaped';
  li.textContent = 'regex-escaped.user.js:  @include /headers-include-regex\\/headers-include-regex\\.html/';
  document.getElementById('log').appendChild(li);
})();
