// ==UserScript==
// @name        Missing Require
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://example.com/*
// @version     1.0.1
// >>> the error: no such file next to this script.
// @require     ./does-not-exist.js
// ==/UserScript==
console.log('[bad-examples/missing-require] header is well-formed but the @require points at a file that does not exist');
