// ==UserScript==
// @name        SourceMonkey example: use-strict: top-level 'use strict' in the page world
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Reports whether a 'use strict' at the very top of the script puts it in strict mode.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/use-strict/use-strict.html
// @match       *://*/*use-strict/use-strict.html
// @match       file:///*/use-strict/use-strict.html
// @run-at      document-end
// @inject-into page
// @grant       none
// ==/UserScript==
'use strict';

// A sloppy-mode function called plainly gets the global object as
// `this`; under strict mode it gets undefined. Nested here, so it is
// strict only if the 'use strict' above applied to the whole script.
const strict = (function () { return this === undefined; })();

const li = document.createElement('li');
li.dataset.script = 'page';
li.dataset.strict = String(strict);
li.textContent = `[page world] strict mode: ${strict ? 'on' : 'off'}`;
document.getElementById('log').appendChild(li);
