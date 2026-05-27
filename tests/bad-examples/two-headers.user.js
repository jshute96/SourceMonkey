// ==UserScript==
// @name        Two Headers (first)
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.1
// ==/UserScript==
console.log('[bad-examples/two-headers] two metadata blocks; SourceMonkey honors the first and treats the second as code');

// ==UserScript==
// @name        Two Headers (second — currently swallowed into the body)
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     2.0.1
// ==/UserScript==
console.log('[bad-examples/two-headers] after second metadata block');
