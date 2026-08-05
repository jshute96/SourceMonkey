// ==UserScript==
// @name        Stray Closing Brace At End
// @namespace   https://github.com/jshute96/SourceMonkey
// @match       https://example.com/*
// @version     1.0.0
// ==/UserScript==
// The sibling of stray-brace.user.js, and the harder half. There the
// stray brace has code after it, which makes the two probes' messages
// differ — an easy tell. Here the brace is the last thing in the file,
// and the tell disappears:
//
// The wrapped probe escapes the wrapper, runs out of source, and hits
// the closing `}` the probe machinery itself appends — reporting
// `Unexpected token '}'`, which is the very same message a stray `}`
// produces for the verdict. So the messages AGREE while the wrapper
// did not hold at all.
//
// What separates them is range: the wrapped probe's line is past the
// end of the file, and the raw probe's is not. See
// docs/parse-check.md, "Why there are two probes".

function greet(name) {
  console.log(`hello ${name}`);
}
// >>> the error: this brace closes nothing, and nothing follows it.
}
