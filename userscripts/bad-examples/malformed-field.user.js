// ==UserScript==
// @name        Malformed Field
// @description A @match written with = instead of a space, so the script has no @match and is invalid
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match=https://example.com/*
// @grant
// @version     1.0.2
// ==/UserScript==
console.log('[bad-examples/malformed-field] the @match line uses = instead of whitespace, so the line never parses as @match → script fails validation');
