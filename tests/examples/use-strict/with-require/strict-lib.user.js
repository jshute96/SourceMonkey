// ==UserScript==
// @name        SourceMonkey example: use-strict: 'use strict' with a @require (strict-lib)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.4
// @description Reports whether the script runs in strict mode when it has a @require.
// @match       *://*/*use-strict/use-strict.html
// @match       file:///*/use-strict/use-strict.html
// @run-at      document-end
// @inject-into content
// @grant       GM_info
// @require     https://jshute96.github.io/SourceMonkey/tests/examples/use-strict/with-require/lib-strict.js
// ==/UserScript==

// No directive here, but the @require starts with one: strict mode is on.
const strict = (function () { return this === undefined; })();

const li = document.createElement('li');
li.dataset.script = 'strict-lib';
li.dataset.strict = String(strict);
li.textContent = `[strict-lib] strict mode: ${strict ? 'on' : 'off'}`;
document.getElementById('log').appendChild(li);
