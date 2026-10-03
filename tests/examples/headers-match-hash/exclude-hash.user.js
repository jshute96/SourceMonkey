// ==UserScript==
// @name        SourceMonkey example: Hash matching: @exclude of the hash
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.6
// @description @match names the page, and @exclude *#part names it with #part. This matches except with #part.*
// @match       *://*/headers-match-hash/headers-match-hash.html
// @match       file:///*/headers-match-hash/headers-match-hash.html
// @exclude     *#part
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // @match names the page, and @exclude *#part names it with #part. This
  // matches except with #part.*
  //
  // * Tampermonkey ignores the hash, so it always matches there.
  const li = document.createElement('li');
  li.dataset.script = 'exclude-hash';
  li.textContent = 'exclude-hash.user.js:  @match *://*/headers-match-hash/headers-match-hash.html + @exclude *#part';
  document.getElementById('log').appendChild(li);
})();
