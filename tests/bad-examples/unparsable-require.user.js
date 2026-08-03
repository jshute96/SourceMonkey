// ==UserScript==
// @name        Unparsable Require
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.0
// @require     ./unparsable-require-lib.js
// ==/UserScript==
// Loads fine — the @require fetches successfully and the header is
// well-formed, so this script's status is `ok`. It fails at INJECTION
// time instead: the require has an unterminated block comment, and
// requires share one injected entry with the body, so the whole entry
// fails to parse and nothing below ever runs.
//
// Unlike the rest of this corpus (which fails at load time and shows
// up as an ERROR status), the only evidence here is a runtime report:
// the sentinel js[] entry notices __smRun was never called and sends
// an sm:error, so the Log tab and badge show "failed to parse".
console.log('[bad-examples/unparsable-require] this line is unreachable — the @require above cannot parse');
