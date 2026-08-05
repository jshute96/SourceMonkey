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
    // something. `new Function` reports no position at all; the line
    // comes from the probes, checked separately below.
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

test.describe('parse check / locating the error', () => {
  // These pin the half of the feature that `new Function` cannot do.
  // They need a real browser twice over: the probes rely on Chrome
  // firing a window `error` event with a position for a failed inline
  // `<script>` parse, and on the sandbox CSP allowing that script to be
  // parsed at all.

  test('reports the line and column of a syntax error', async ({ sm }) => {
    const verdicts = await sm.checkParses(['var a = 1;\nvar b = 2;\nlet c = ;\nvar d = 4;']);
    expect(verdicts![0].status).toBe('syntax-error');
    // Both probes agree here, and the wrapped one wins because its
    // message matches the verdict's.
    expect(verdicts![0].probes?.wrapped).toMatchObject({ line: 3 });
    expect(verdicts![0].probes?.wrapped?.message).toBe(verdicts![0].message);
  });

  test('finds an error nested inside a function', async ({ sm }) => {
    // V8 pre-parses function bodies lazily, so "is an early error
    // inside a function reported at compile time?" is a real question.
    // It is — otherwise the probe would find nothing to report.
    const verdicts = await sm.checkParses(['var a = 1;\nfunction f() {\n  let z = ;\n}']);
    expect(verdicts![0].probes?.wrapped).toMatchObject({ line: 3 });
  });

  test('locates a brace the wrapped probe would have swallowed', async ({ sm }) => {
    // A source whose leading `}` closes the wrapper — ours AND the one
    // `new Function` builds internally. The wrapped probe runs on past
    // it to a later error; only the raw probe names the brace.
    const verdicts = await sm.checkParses(['}\nvar a = 1;\nlet z = ;']);
    expect(verdicts![0].status).toBe('syntax-error');
    expect(verdicts![0].probes?.raw).toMatchObject({ line: 1 });
    // The divergence that `selectParseLocation` keys on: when the
    // wrapper is absorbed, the two messages cannot agree.
    expect(verdicts![0].probes?.wrapped?.message).not.toBe(verdicts![0].message);
  });

  test('a brace at the very end still resolves, though the messages agree', async ({ sm }) => {
    // The trap in the selection rule. With nothing after the stray `}`
    // the wrapped probe escapes the wrapper, runs out of source, and
    // hits the closing `}` the probe machinery appends — producing the
    // SAME message the verdict got. Agreement no longer proves the
    // wrapper held, so the range check is what has to catch it.
    const source = 'var a=1;\nfunction b(){}\n}';
    const lines = source.split('\n').length;
    const verdicts = await sm.checkParses([source]);
    expect(verdicts![0].status).toBe('syntax-error');
    expect(verdicts![0].probes?.wrapped?.message).toBe(verdicts![0].message);
    // The wrapped probe agrees and is wrong: its line is our own
    // appended brace, past the end of the source.
    expect(verdicts![0].probes?.wrapped?.line).toBeGreaterThan(lines);
    // The raw probe has the line the user has to go and fix.
    expect(verdicts![0].probes?.raw).toMatchObject({ line: 3 });
  });

  test('the probes never execute the source they locate', async ({ sm }) => {
    // The guarantee the sentinel exists for. This source is an invalid
    // function body, so it reaches the probes — and it is crafted to
    // close the wrapper and leave a statement at the top level, which
    // is exactly the shape that DID execute before the sentinel was
    // added.
    //
    // If it ran, the `throw` would surface through the same window
    // `error` listener the probes read, and its message would land in
    // the probe result. So asserting on the message is a real test of
    // "nothing ran", not a proxy for one.
    const verdicts = await sm.checkParses([
      '}\nthrow new Error("PROBE-EXECUTED");\nfunction tail() {',
    ]);
    expect(verdicts![0].status).toBe('syntax-error');
    const messages = [
      verdicts![0].message,
      verdicts![0].probes?.wrapped?.message,
      verdicts![0].probes?.raw?.message,
    ].join(' | ');
    expect(messages).not.toContain('PROBE-EXECUTED');
  });

  test('reports a position past the source when it ends mid-construct', async ({ sm }) => {
    // An unclosed block: V8 consumes everything and stops at the
    // probe's own sentinel, past the end of the checked text.
    // `selectParseLocation` drops such a position rather than blaming a
    // line the user never wrote, so this pins the wire-level fact that
    // makes it detectable — both probes report beyond the last line.
    const source = 'if (1) {\nvar a = 1;';
    const lines = source.split('\n').length;
    const verdicts = await sm.checkParses([source]);
    expect(verdicts![0].status).toBe('syntax-error');
    expect(verdicts![0].probes?.raw?.line).toBeGreaterThan(lines);
    expect(verdicts![0].probes?.wrapped?.line).toBeGreaterThan(lines);
  });

  test('an unterminated string is still placed on its own line', async ({ sm }) => {
    // The contrast with the case above: "ends mid-construct" does not
    // always mean "no position". V8 reports an unterminated string at
    // the string, which is a line worth showing.
    const verdicts = await sm.checkParses(['var a = 1;\nvar s = "oops;\nvar b = 2;']);
    expect(verdicts![0].probes?.wrapped).toMatchObject({ line: 2 });
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
