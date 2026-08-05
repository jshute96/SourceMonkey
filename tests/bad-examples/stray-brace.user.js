// ==UserScript==
// @name        Stray Closing Brace
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.0
// ==/UserScript==
// The case the two-probe design exists for. A stray `}` closes the
// wrapper the check compiles inside — and `new Function` is itself a
// wrapper, so it has the same blind spot. Both then run on and report
// whatever they hit afterwards, which is not the brace.
//
// The raw probe has no wrapper to swallow, so it is the one that can
// place the brace itself, and the checker picks it precisely because
// the two probes' messages disagree here. Compare with
// syntax-error-body.user.js, where they agree and the wrapped probe
// wins.
//
// See docs/parse-check.md, "Why there are two probes".

function greet(name) {
  console.log(`hello ${name}`);
}
// >>> the error: this brace closes nothing.
}

greet('world');
