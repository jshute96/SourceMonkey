// ==UserScript==
// @name        Two Headers (first)
// @match       https://example.com/*
// @version     1.0.1
// ==/UserScript==
console.log('[bad-examples/two-headers] two metadata blocks; SourceMonkey honors the first and treats the second as code');

// ==UserScript==
// @name        Two Headers (second — currently swallowed into the body)
// @match       https://example.com/*
// @version     2.0.1
// ==/UserScript==
console.log('[bad-examples/two-headers] after second metadata block');
