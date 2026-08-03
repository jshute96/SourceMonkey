// Library with a deliberate syntax error, @require'd by
// unparsable-require.user.js.
//
// The block comment below is never closed, so the whole file is
// unparsable. Requires are concatenated into the same injected entry
// as the script body (see docs/injection-modes.md), which means this
// takes the ENTIRE script down at parse time — the body never runs.
// The trailing sentinel entry is what turns that from a silent
// nothing-happens into a reported error.

function neverReached() {
  return 'this file cannot parse';
}

/* deliberately unterminated block comment — everything past here is
   swallowed and the file ends mid-comment
