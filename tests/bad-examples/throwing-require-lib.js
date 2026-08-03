// Library that throws while it runs, @require'd by
// throwing-require.user.js.
//
// Parses cleanly — the failure is at execution, not parse. Requires
// run inside the same wrap function as the script body, ahead of it,
// so this throw propagates out before the body's first line and the
// script is abandoned. Tampermonkey/Violentmonkey behave the same way
// (they concatenate into one IIFE); the previous separate-entries
// arrangement let the body run anyway.
//
// The prelude's error path reports this normally, so it shows up in
// the Log tab with a stack trace — unlike the unparsable case next
// door, which never reaches any of our code.

const REQUIRE_MARKER = 'throwing-require-lib';

throw new Error(`${REQUIRE_MARKER}: intentional top-level failure while the @require runs`);
