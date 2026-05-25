// ==UserScript==
// @name        Missing Require
// @match       https://example.com/*
// @version     1.0.0
// @require     ./does-not-exist.js
// ==/UserScript==
console.log('[bad-examples/missing-require] header is well-formed but the @require points at a file that does not exist');
