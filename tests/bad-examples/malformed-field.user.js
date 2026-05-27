// ==UserScript==
// @name        Malformed Field
// @namespace   https://github.com/jshute96/SourceMonkey
// @match=https://example.com/*
// @grant
// @version     1.0.0
// ==/UserScript==
console.log('[bad-examples/malformed-field] the @match line uses = instead of whitespace, so the line never parses as @match → script fails validation');
