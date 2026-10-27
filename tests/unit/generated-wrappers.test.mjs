// Guard test for the injection minifier in scripts/build.mjs
// (minifyForInjection, which runs terser). Each emitted wrapper must
// be syntactically valid JavaScript with a few load-bearing tokens
// intact, so a minifier setting that breaks one fails here instead of
// only at injection time in a real page.

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
  test(`${name}: is a non-empty string`, () => {
    assert.equal(typeof code, 'string');
    assert.ok(code.length > 0, 'wrapper should not be empty');
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
  assert.match(WRAPPER_PRELUDE, /__smGate/);
  // The channel key's stand-in, swapped for the key at registration.
  for (const code of [WRAPPER_PRELUDE, WRAPPER_BRIDGE, WRAPPER_GM_RUNTIME]) assert.match(code, /"__SM_KEY__"/);
  // A full marker, not the shared `sourcemonkey-` prefix: that prefix
  // matches all the live markers, so it would pass even if the one the
  // request path needs were mistyped.
  assert.match(WRAPPER_BRIDGE, /sourcemonkey-sync-/);
  // The bridge's script stand-in, swapped by `onlyScript`.
  assert.match(WRAPPER_BRIDGE, /"__SM_ONLY__"/);
  assert.match(WRAPPER_GM_RUNTIME, /__smGate/);
});
