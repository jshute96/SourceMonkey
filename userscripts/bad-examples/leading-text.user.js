/* MIT-licensed example — this comment block sits above the metadata
   block on purpose, to exercise the viewer's leadingText path. */
'use strict';
console.log('[bad-examples/leading-text] logging above the ==UserScript== header');

// ==UserScript==
// @name        Leading Text
// @namespace   https://github.com/jshute96/SourceMonkey
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://example.com/*
// @version     1.0.2
// ==/UserScript==
console.log('[bad-examples/leading-text] text above the ==UserScript== line should still render in the viewer');
