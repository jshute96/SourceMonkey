// ==UserScript==
// @name        Throwing Require
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.0
// @require     ./throwing-require-lib.js
// ==/UserScript==
// Loads fine — the @require fetches and parses, so this script's
// status is `ok`. It fails at RUN time: the library throws at its own
// top level, which happens before the body's first line because
// requires are concatenated ahead of it in the same wrap function.
//
// The pair to unparsable-require.user.js. Both leave the body
// unexecuted, but this one runs far enough for our error path to see
// it, so the Log tab gets a real message and stack trace. The
// unparsable one dies at parse time and is only caught by the
// sentinel entry.
console.log('[bad-examples/throwing-require] this line is unreachable — the @require above throws first');
