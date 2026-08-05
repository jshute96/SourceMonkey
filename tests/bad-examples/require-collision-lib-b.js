// Second half of the join-only collision, @require'd by
// require-collision.user.js. This file also parses on its own; it
// declares the same `const` as require-collision-lib-a.js, and a
// `const` cannot be declared twice in one scope.
//
// V8 reports a duplicate declaration at the SECOND one, so this is the
// file the error should be attributed to — naming lib-a would send you
// to the file that did nothing wrong.

function fromLibB() {
  return 'lib-b';
}

// >>> the error, but only once this file is concatenated after lib-a.
const SHARED_CONFIG = { source: 'require-collision-lib-b' };
