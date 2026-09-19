// Guard test for the hand-rolled injection minifier in
// scripts/build.mjs (minifyForInjection). It does three regex passes —
// strip /* */ comments, strip whole-line // comments, collapse all
// whitespace (including newlines) to single spaces — which relies on
// invariants the wrapper sources must hold:
//   - no multiline template literal whose newlines are significant
//     (they'd collapse to a space),
//   - every statement semicolon-terminated (no ASI dependence once the
//     newlines are gone),
//   - no `/* ... */` or line-leading `//` sequence inside a string.
//
// Rather than assert those invariants directly, this checks the OUTPUT:
// each emitted wrapper must be a single physical line of syntactically
// valid JavaScript, with a few load-bearing tokens intact. If a future
// edit to a wrapper-*.js / userscript-prelude.js trips a minifier
// invariant, the produced string stops parsing (or loses its sentinel)
// and this test fails instead of the breakage only surfacing at
// injection time in a real page.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WRAPPER_PRELUDE,
  WRAPPER_BRIDGE,
  WRAPPER_GM_RUNTIME,
} from '../../dist/generated-wrappers.js';

const wrappers = {
  WRAPPER_PRELUDE,
  WRAPPER_BRIDGE,
  WRAPPER_GM_RUNTIME,
};

for (const [name, code] of Object.entries(wrappers)) {
  test(`${name}: minified to a single non-empty line`, () => {
    assert.equal(typeof code, 'string');
    assert.ok(code.length > 0, 'wrapper should not be empty');
    assert.ok(!/[\n\r]/.test(code), 'minified wrapper must be a single physical line');
  });

  test(`${name}: is syntactically valid JavaScript`, () => {
    // new Function() PARSES the body (throws SyntaxError on invalid
    // code) without executing it, so this validates syntax even though
    // the wrappers reference self/window/chrome/document at runtime.
    assert.doesNotThrow(() => new Function(code), 'minified wrapper must parse');
  });
}

test('sentinel tokens survive minification', () => {
  // A handful of load-bearing strings/identifiers that the SW and the
  // matcher depend on — if the minifier ever ate a string boundary
  // these would vanish.
  assert.match(WRAPPER_PRELUDE, /sm:check-pending/);
  assert.match(WRAPPER_PRELUDE, /__smPrelude/);
  // The port-aware matcher's digit test (see the @match :port handling).
  assert.ok(WRAPPER_PRELUDE.includes('\\d+'), 'prelude port regex should survive');
  // A full marker, not the shared `sourcemonkey-bridge` prefix: that
  // prefix matches all three live markers, so it would pass even if the
  // one the request path needs were mistyped.
  assert.match(WRAPPER_BRIDGE, /sourcemonkey-bridge-sync/);
  assert.match(WRAPPER_GM_RUNTIME, /__SM_GM__/);
});
