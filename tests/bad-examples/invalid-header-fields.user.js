// ==UserScript==
// @name             Invalid Header Fields
// @namespace        https://github.com/jshute96/SourceMonkey
// @match            https://example.com/*
// @version          1.0.0
// @cookie-jar       enabled
// @nuke-from-orbit
// @42invalid        starts with a digit so the parser ignores the line entirely
// @x-vendor-flag    on
// @match            https://example.com
// ==/UserScript==
console.log('[bad-examples/invalid-header-fields] weird or unknown @tag names do not invalidate the script — the parser is policy-free');
