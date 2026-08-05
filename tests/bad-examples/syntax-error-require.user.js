// ==UserScript==
// @name        Syntax Error In Require
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.0
// @require     ./syntax-error-require-lib.js
// ==/UserScript==
// The attribution case. This file is perfectly valid JavaScript; the
// broken code is in the library above. Because requires and the body
// are concatenated into one injected entry, the compile check sees a
// single program — so the interesting question is whether the error
// comes back pointing at the library or at this file.
//
// It should name syntax-error-require-lib.js, at a line within that
// library. A report against this file would send you to the wrong
// place entirely.
console.log('[bad-examples/syntax-error-require] unreachable — the @require above cannot parse');
