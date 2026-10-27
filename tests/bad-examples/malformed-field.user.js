// ==UserScript==
// @name        Malformed Field
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match=https://example.com/*
// @grant
// @version     1.0.1
// ==/UserScript==
console.log('[bad-examples/malformed-field] the @match line uses = instead of whitespace, so the line never parses as @match → script fails validation');
