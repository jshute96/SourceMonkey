// ==UserScript==
// @name        Invalid Match
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// >>> the error: a bare origin — Chrome's match-pattern grammar wants a path.
// @match       https://example.org
// @version     1.0.0
// ==/UserScript==
// Not invalid: a `@match` Chrome would refuse is dropped, and the
// script still runs everywhere its other patterns say — here,
// https://example.com/*.
//
// Why the drop matters: Chrome refuses a registration as a WHOLE over
// one malformed pattern, so passing this header through verbatim would
// stop the script running anywhere at all, and the only explanation
// would be Chrome's own "matches[1]: Empty path" — which names an index
// in a list the user never wrote.
//
// So the pattern is checked at parse time instead, and the WARNING in
// the viewer's Log tab points at the header line that declared it.
// `unusable-match.user.js` is the same problem with no good pattern
// left beside it, which is an error rather than a warning.

console.log('[bad-examples/invalid-match] runs on example.com; check the Log tab for the dropped @match');
