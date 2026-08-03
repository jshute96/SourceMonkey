// The compile-only parse check: service worker → offscreen document →
// sandboxed iframe → `new Function`.
//
// This spec is about the mechanism, not the feature built on it. It has
// to run in a real browser because the whole point is which CSP applies
// where: the service worker and the offscreen document both forbid
// `eval`, and only the sandboxed page declared in `sandbox.pages` may
// allow it. Nothing about that is observable outside Chrome.
//
// The load-bearing property is asymmetric. A false "didn't parse" would
// flip a working script to invalid, so the checks below pin BOTH
// directions — real code accepted, broken code rejected — and pin the
// "compiled, never called" guarantee directly.

import { test, expect } from '../fixtures/extension';

test.describe('parse check', () => {
  test('accepts real userscript source and rejects a syntax error', async ({ sm }) => {
    const verdicts = await sm.checkParses([
      'const a = 1;\nfunction f() { return a; }\nf();',
      'var x = 1;\n/* unterminated',
      'const ok = () => 42;',
    ]);
    expect(verdicts).not.toBeNull();
    expect(verdicts!.map((v) => v.ok)).toEqual([true, false, true]);
    // The message is what we surface to the user, so it has to say
    // something. V8 gives no line or column for a `new Function`
    // SyntaxError — attribution comes from checking pieces separately.
    expect(verdicts![1].message).toBeTruthy();
  });

  test('compiles without executing', async ({ sm }) => {
    // The guarantee the whole design rests on. If `new Function` ever
    // became a call site, this source would throw — and a throw is not
    // a SyntaxError, so it would come back `ok: false` and this fails
    // loudly rather than silently running untrusted code.
    const verdicts = await sm.checkParses([
      'throw new Error("this must never run");',
      'while (true) {}',
    ]);
    expect(verdicts).not.toBeNull();
    expect(verdicts!.map((v) => v.ok)).toEqual([true, true]);
  });

  test('judges source as a function body, not as a program', async ({ sm }) => {
    // What the injected entry actually is. A top-level `return` is
    // legal in a function body and a SyntaxError in a program, so a
    // checker that got this wrong would reject working scripts — the
    // exact failure that ruled out bundling a standalone JS parser.
    const verdicts = await sm.checkParses(['return 1;']);
    expect(verdicts![0].ok).toBe(true);
  });

  test('catches a conflict that only exists once files are concatenated', async ({ sm }) => {
    // Two libraries that are each fine alone and collide when joined.
    // This is why the feature checks the composed program and not just
    // the individual files: per-file checking alone would call this
    // script healthy and let it fail at injection time.
    const lib1 = 'const shared = 1;';
    const lib2 = 'const shared = 2;';
    const verdicts = await sm.checkParses([lib1, lib2, `${lib1}\n;\n${lib2}`]);
    expect(verdicts!.map((v) => v.ok)).toEqual([true, true, false]);
    expect(verdicts![2].message).toMatch(/already been declared/i);
  });

  test('handles source with characters that need real UTF-8 handling', async ({ sm }) => {
    // Userscripts are full of these — the script that motivated the
    // concatenated arrangement is half Chinese. postMessage carries
    // strings, so this is really pinning that nothing along the chain
    // mangles them into a spurious syntax error.
    const verdicts = await sm.checkParses([
      'const 名前 = "🎉"; // 増強\nconst ok = 名前.length;',
      'const bad = "🎉',
    ]);
    expect(verdicts!.map((v) => v.ok)).toEqual([true, false]);
  });

  test('an empty batch needs no offscreen document', async ({ sm }) => {
    expect(await sm.checkParses([])).toEqual([]);
  });

  test('repeated batches reuse one offscreen document', async ({ sm }) => {
    // `chrome.offscreen.createDocument` rejects when a document already
    // exists and there is no create-if-absent call, so a second batch
    // racing the first is a real failure mode. Serial and concurrent
    // both have to work.
    const first = await sm.checkParses(['const a = 1;']);
    expect(first![0].ok).toBe(true);

    const batches = await Promise.all([
      sm.checkParses(['const b = 1;']),
      sm.checkParses(['const c = (']),
      sm.checkParses(['const d = 1;']),
    ]);
    expect(batches.map((b) => b!.map((v) => v.ok))).toEqual([[true], [false], [true]]);
  });
});
