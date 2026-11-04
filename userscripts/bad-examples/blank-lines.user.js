// ==UserScript==
// @name        Blank Lines
// @description Blank lines and bare // lines inside the metadata block, which are ignored
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png

// @match       https://example.com/*
//
// @version     1.0.2

//

// @grant       GM_info
// @grant       GM_BadAPI
// ==/UserScript==
console.log('[bad-examples/blank-lines] blank lines and bare `//` lines inside the header block are silently ignored by the parser');
