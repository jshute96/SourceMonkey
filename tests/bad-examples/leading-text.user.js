/* MIT-licensed example — this comment block sits above the metadata
   block on purpose, to exercise the viewer's leadingText path. */
'use strict';
console.log('[bad-examples/leading-text] logging above the ==UserScript== header');

// ==UserScript==
// @name        Leading Text
// @match       https://example.com/*
// @version     1.0.1
// ==/UserScript==
console.log('[bad-examples/leading-text] text above the ==UserScript== line should still render in the viewer');
