// ==UserScript==
// @name        SourceMonkey example: use-strict: 'use strict' with a @require (own-after-lib)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Reports whether the script runs in strict mode when it has a @require.
// @match       *://*/*use-strict/use-strict.html
// @match       file:///*/use-strict/use-strict.html
// @run-at      document-end
// @inject-into content
// @grant       GM_info
// @require     ./lib-plain.js
// ==/UserScript==
'use strict';

// Its own 'use strict' comes after the @require's code, so it does
// nothing: strict mode is off, as in Tampermonkey and Violentmonkey.
const strict = (function () { return this === undefined; })();

const li = document.createElement('li');
li.dataset.script = 'own-after-lib';
li.dataset.strict = String(strict);
li.textContent = `[own-after-lib] strict mode: ${strict ? 'on' : 'off'}`;
document.getElementById('log').appendChild(li);
