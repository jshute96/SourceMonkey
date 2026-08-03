// Second library for this example, reached only by a RELATIVE
// `@require ./relative-lib.js`.
//
// Why it exists as a separate file from `lib.js`:
//
//   - `lib.js` is required by absolute URL from the two portable
//     scripts, so any manager can fetch it. That absolute URL points
//     at this repo's `main` branch on raw.githubusercontent.com, which
//     means the copy a foreign manager fetches is whatever is on
//     `main` — not whatever is in the working tree.
//   - This file is only ever reached through a relative path, which is
//     a SourceMonkey extension. Nothing outside SourceMonkey fetches
//     it, so it is the safe place to put behavior that has to change
//     in lockstep with the example.
//
// The declarations mirror `lib.js`'s shape on purpose: a script-scoped
// `const` and a `function`. If the relative ref resolved but the
// concatenation regressed, reading `REQUIRE_SCOPE_RELATIVE_CONST`
// would throw ReferenceError rather than silently degrading.
//
// Note the top-level read of `REQUIRE_SCOPE_CONST`, which `lib.js`
// declares. That is deliberate, and it's what makes the host script
// pin require ORDER rather than merely co-scoping: `lib.js` is listed
// first in the header, so its `const` is already initialized by the
// time this line runs. Flip the two `@require` lines and this throws a
// ReferenceError from the TDZ instead of silently still working.

const REQUIRE_SCOPE_RELATIVE_CONST =
  `const from relative-lib.js, which already saw "${REQUIRE_SCOPE_CONST}"`;

function requireScopeRelativeFn(world) {
  return `function from relative-lib.js, called in the ${world} world`;
}
