// ==UserScript==
// @name        Unparsable Require
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.0
// @require     ./unparsable-require-lib.js
// ==/UserScript==
// The @require fetches successfully and the header is well-formed, so
// nothing about LOADING this script fails. What makes it invalid is
// the code: the require has an unterminated block comment, and requires
// share one injected entry with the body, so the whole entry would fail
// to parse and nothing below would ever run.
//
// The install-time compile check catches that before the script is
// registered, so this shows up as INVALID next to the script rather
// than as a surprise the first time you visit a matching page.
//
// The unterminated-construct variant of the location cases: the error
// has no natural end to point at, and V8 blames the `/*` that opened
// it. See syntax-error-require.user.js for the ordinary shape.
console.log('[bad-examples/unparsable-require] this line is unreachable — the @require above cannot parse');
