// ==UserScript==
// @name        Require Collision
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://example.com/*
// @version     1.0.1
// @require     ./require-collision-lib-a.js
// @require     ./require-collision-lib-b.js
// ==/UserScript==
// An error that exists only in the join. Every file here parses on its
// own — this one, lib-a and lib-b — so nothing short of compiling the
// concatenated program can see it. Two libraries declaring the same
// top-level `const` is the everyday version: it is the direct cost of
// concatenating requires into one lexical scope, which is also what
// makes a library's `const` visible to the body at all.
//
// The report should name require-collision-lib-b.js, at the line its
// `SHARED_CONFIG` declaration is on.
console.log('[bad-examples/require-collision] unreachable —', fromLibA(), fromLibB());
