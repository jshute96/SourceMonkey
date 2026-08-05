// ==UserScript==
// @name        Unusable Match
// @namespace   https://github.com/jshute96/SourceMonkey
// >>> the error: the only @match is one Chrome refuses, and there is no @include.
// @match       https://example.com
// @version     1.0.0
// ==/UserScript==
// A script with no pattern Chrome would accept and nothing else to
// match on, so it can never run on any page — the same position as a
// script that declared no `@match` at all, which is why it is INVALID
// rather than a warning like `invalid-match.user.js`.
//
// The message is the pattern's own reason rather than the generic "no
// @match or @include", because there IS one here and pointing at the
// metadata marker would send the reader to a line with nothing wrong.

console.log('[bad-examples/unusable-match] never runs');
