// ==UserScript==
// @name             Invalid Header Fields
// @description      Unknown and oddly named @tags, which don't make the script invalid
// @namespace        https://github.com/jshute96/SourceMonkey
// @icon             https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match            https://example.com/*
// @version          1.0.2
// @cookie-jar       enabled
// @nuke-from-orbit
// @42invalid        starts with a digit so the parser ignores the line entirely
// @x-vendor-flag    on
// ==/UserScript==
console.log('[bad-examples/invalid-header-fields] weird or unknown @tag names do not invalidate the script — the parser is policy-free');
