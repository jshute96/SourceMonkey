// ==UserScript==
// @name        Syntax Error In Body
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://example.com/*
// @version     1.0.1
// ==/UserScript==
// The plainest location case: no @require, so the composed program the
// install-time check compiles is just this file behind our GM-bindings
// preamble. The reported line should be the line number you see in an
// editor — i.e. counted from `// ==UserScript==` above, not from the
// first line of the body.
//
// Getting that wrong by the height of the header is the mistake this
// file exists to make visible.

function parsesFine() {
  return 'everything above the marker below is valid';
}

// >>> the error: an assignment with no right-hand side.
let broken = ;

console.log('[bad-examples/syntax-error-body] unreachable — the line above cannot parse');
