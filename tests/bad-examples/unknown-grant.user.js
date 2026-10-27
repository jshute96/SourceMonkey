// ==UserScript==
// @name        Unknown Grant
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://example.com/*
// @version     1.0.1
// @grant       GM_setValue
// >>> the error: no such GM API, so this grant is dropped.
// @grant       GM_notARealApi
// @grant       GM_alsoNotReal
// ==/UserScript==
// The only bad-example here that is NOT invalid.
//
// An unsupported `@grant` doesn't stop the script running — the name is
// dropped and everything else is granted as asked. So this loads as OK
// and reports a `parser` WARNING in the viewer's Log tab instead of an
// error next to the script.
//
// What it exists to show is that a warning gets a clickable location
// too, not just a failure. The message names both unknown grants; the
// link goes to the FIRST of them, which is where you'd start fixing.
//
// Note the location is a line in the *header* — the line numbering is
// counted from the top of the file, so it matches the viewer's gutter
// rather than an offset into the body.

console.log('[bad-examples/unknown-grant] this script runs; check the Log tab for the warning');
