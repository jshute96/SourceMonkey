// Library with a deliberate syntax error, @require'd by
// syntax-error-require.user.js.
//
// Unlike unparsable-require-lib.js (which ends mid-comment, so there is
// no line to blame) this one fails at a specific token in the middle of
// the file. The install-time check should name THIS file and the line
// the error is on, counted within this file rather than within the
// concatenated program the check actually compiles.

const LIB_NAME = 'syntax-error-require-lib';

function helper() {
  return 'this function is fine';
}

// >>> the error: `if` with an empty condition.
if () {
  helper();
}

function alsoFine() {
  return 'never reached, but it parses';
}
