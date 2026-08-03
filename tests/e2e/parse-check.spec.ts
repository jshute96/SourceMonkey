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
    expect(verdicts!.map((v) => v.status)).toEqual(['ok', 'syntax-error', 'ok']);
    // The message is what we surface to the user, so it has to say
    // something. V8 gives no line or column for a `new Function`
    // SyntaxError, and no file — so the message is all we have.
    expect(verdicts![1].message).toBeTruthy();
  });

  test('compiles without executing', async ({ sm }) => {
    // The guarantee the whole design rests on. If `new Function` ever
    // became a call site, this source would throw — and a throw that
    // isn't a SyntaxError comes back `unknown`, so this fails loudly
    // rather than silently running untrusted code.
    const verdicts = await sm.checkParses([
      'throw new Error("this must never run");',
      'while (true) {}',
    ]);
    expect(verdicts).not.toBeNull();
    expect(verdicts!.map((v) => v.status)).toEqual(['ok', 'ok']);
  });

  test('judges source as a function body, not as a program', async ({ sm }) => {
    // What the injected entry actually is. A top-level `return` is
    // legal in a function body and a SyntaxError in a program, so a
    // checker that got this wrong would reject working scripts — the
    // exact failure that ruled out bundling a standalone JS parser.
    const verdicts = await sm.checkParses(['return 1;']);
    expect(verdicts![0].status).toBe('ok');
  });

  test('catches a conflict that only exists once files are concatenated', async ({ sm }) => {
    // Two libraries that are each fine alone and collide when joined.
    // This is why the feature checks the composed program and not just
    // the individual files: per-file checking alone would call this
    // script healthy and let it fail at injection time.
    const lib1 = 'const shared = 1;';
    const lib2 = 'const shared = 2;';
    const verdicts = await sm.checkParses([lib1, lib2, `${lib1}\n;\n${lib2}`]);
    expect(verdicts!.map((v) => v.status)).toEqual(['ok', 'ok', 'syntax-error']);
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
    expect(verdicts!.map((v) => v.status)).toEqual(['ok', 'syntax-error']);
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
    expect(first![0].status).toBe('ok');

    const batches = await Promise.all([
      sm.checkParses(['const b = 1;']),
      sm.checkParses(['const c = (']),
      sm.checkParses(['const d = 1;']),
    ]);
    expect(batches.map((b) => b!.map((v) => v.status)))
      .toEqual([['ok'], ['syntax-error'], ['ok']]);
  });
});

test.describe('parse check / non-syntax failures', () => {
  test('a parser resource limit is reported as unknown, not as a syntax error', async ({ sm }) => {
    // The invariant the whole feature rests on: only V8 saying
    // "SyntaxError" may disable a script. This source is perfectly
    // valid JavaScript that happens to exhaust the parser's recursion
    // budget HERE — inside a message handler inside a promise chain —
    // which is not the budget `chrome.userScripts` compiles the real
    // entry with. Reporting it as a syntax error would disable a
    // script V8 is willing to run.
    //
    // The same guard covers the case that can't be tested for: if the
    // sandbox CSP ever stopped applying, `new Function` would throw
    // EvalError and every script in the profile would be branded
    // broken at once.
    const nested = '('.repeat(100_000) + '1' + ')'.repeat(100_000);
    const verdicts = await sm.checkParses([nested]);
    expect(verdicts).not.toBeNull();
    expect(verdicts![0].status).toBe('unknown');
  });

});
