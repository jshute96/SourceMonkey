// Library with a deliberate syntax error, @require'd by
// unparsable-require.user.js.
//
// The block comment below is never closed, so the whole file is
// unparsable. Requires are concatenated into the same injected entry
// as the script body (see docs/injection-modes.md), which means this
// would take the ENTIRE script down at parse time — so the
// install-time compile check refuses the script before it is ever
// registered.
//
// The error runs to the end of the file, which is the shape that has
// nowhere obvious to point. V8 still blames the token that opened the
// construct, so the report lands on the `/*` below rather than on the
// end of the file.

function neverReached() {
  return 'this file cannot parse';
}

// >>> the error: the comment opened here is never closed.
/* deliberately unterminated block comment — everything past here is
   swallowed and the file ends mid-comment
