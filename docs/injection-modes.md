# Injection modes

How SourceMonkey arranges a userscript's code into the `js[]` array
it hands to `chrome.userScripts.register`. Three structurally distinct
choices exist; only the first is implemented today, but the wrap
helpers in `src/injector.ts` are pure-string functions that an
alternative assembler could consume to build either of the others.

For the lifecycle, world, and matcher pieces of injection that don't
depend on the choice of mode, see [injection.md](injection.md).

## TL;DR

- **Mode B — separate entries (default; implemented).** Each
  `@require`, the main body, the per-script config blob, and the
  inlined prelude source are separate `{code}` entries in the
  per-script `js[]` array. Stack traces show the real filename and
  pristine line numbers for every piece of user code. No `eval`.
- **Mode A — concatenated single blob (not implemented).** Requires
  and main body concatenated into a single `{code}` entry inside one
  IIFE. Exact closure-scope semantics; line numbers are off in the
  main body by however many lines the requires take up. No `eval`.
- **Mode C — eval-per-require (not implemented).** One `{code}` entry,
  but inside the IIFE the wrapper `eval`s each require and the main
  body separately with a per-piece `//# sourceURL=`. Exact closure
  semantics AND correct stack traces — but `eval()` runs subject to
  page CSP in MAIN world, so MAIN-world scripts silently break on
  any site that omits `'unsafe-eval'` (GitHub, Google, X, Reddit, …).

## Mode B — separate entries (default)

The shape of `js[]` for one script registration:

```
js: [
  { code: <config blob>      },   // pushes onto self.__smCfgQueue, or
                                  // calls self.__smPrelude.init directly
  { code: <prelude>          },   // WRAPPER_PRELUDE + page-wide sourceURL
  { code: <require 1 wrap>   },   // for each @require, in order
  { code: <require 2 wrap>   },
  ...
  { code: <main body wrap>   },
]
```

All entries share `globalThis` because they run as separate scripts
in the same execution world. Per-script state lives on
`self.__smPrelude.scripts[scriptId]`; helpers (`self.__smActive`,
`self.__smRun`, `self.__smErr`) are installed once per world by
the first prelude run — the IIFE's idempotency guard short-circuits
subsequent runs but still drains any newly-queued configs.

### Why inline the prelude (not register once per page)

Each script ships its own ~12KB copy of `WRAPPER_PRELUDE` in its
`js[]` array. That sounds wasteful — wouldn't a single page-wide
registration be cleaner? It would, but it doesn't work:

- Within ONE `chrome.userScripts.register` entry's `js[]`, Chrome
  runs the entries in array order. The prelude (`js[1]`) is
  guaranteed to install `self.__smActive` / `__smRun` / `__smErr`
  before the require entries (`js[2..]`) and main body call them.
- BETWEEN separate `register` calls, the userScripts API gives no
  ordering guarantee. A separately-registered prelude could run
  AFTER a per-script's main body, which would synchronously throw
  `TypeError: self.__smRun is not a function` and prevent the body
  from running. We hit this in testing.
- The config blob has a queue-or-init pattern that DOES tolerate
  the prelude running later. But the main body and require entries
  don't — they call the helpers immediately. Wrapping each call
  in a defensive `if (self.__smRun) {...}` would silently skip the
  body on a race instead of throwing, which is arguably worse.

So we inline, accept the ~12KB × N duplication, and use the page-
wide `sourcemonkey://SourceMonkey/__prelude.js` sourceURL on every
inclusion so devtools' Sources tree groups them into a single
visible entry (V8 dedups script entries by URL in the tree).

### Pros

- **Real filenames in stack traces.** Each `@require` is its own
  `{code}` entry with a synthetic
  `//# sourceURL=sourcemonkey://SourceMonkey/<folder>/<host>/<path>`
  directive appended; devtools shows it as its own file under the
  owning script's folder. The main body's
  `//# sourceURL=sourcemonkey://SourceMonkey/<folder>/<name>.user.js`
  is no longer shared with require code. See
  [script-source-url.ts](../src/script-source-url.ts) for the URL
  layout.
- **Pristine line numbers for the main body.** The body's line N
  lands at physical line N of the main body entry because the
  declaration preamble (GM bindings, GM prelude, per-script var
  pulls) sits on the same physical line as body line 1. No more
  "subtract the total length of all requires" math when reading a
  stack trace.
- **The prelude has its own devtools entry.** Each per-script
  inclusion carries the page-wide `sourcemonkey://SourceMonkey/__prelude.js`
  sourceURL; devtools' Sources tree dedups by URL so all N
  inclusions show as a single entry. A debugger break there is
  unambiguously a wrapper bug rather than user code.
- **No `eval`.** `chrome.userScripts` injection bypasses page CSP for
  every entry kind — works on GitHub, Google, X, Reddit, etc.

### Cons / caveats

- **Cross-entry scope is reduced to `globalThis`.** Each `{code}`
  entry is its own top-level script, so:
  - `var x = 1` at the top of a require still becomes a global
    (top-level `var` writes a property on `globalThis`); main-body
    references to `x` see it via the global scope chain. Most
    real-world libraries (jQuery, lodash, anything UMD) attach to
    `window`/`globalThis` explicitly and work as before.
  - `let x = 1` or `const x = 1` at the top of a require becomes
    script-scoped — invisible to other entries. A require that
    relied on bare top-level `let`/`const` for cross-piece sharing
    won't work; the workaround is to assign to `globalThis` /
    `window` (matches what every UMD library already does).
- **GM_* bindings aren't visible to require bodies.** The bindings
  (`const GM_setValue = ...` etc.) live as locals of the main-body
  wrap function so they're scoped to the user's code. A require that
  calls a `GM_*` API at parse time won't see it. Workaround: move
  GM-API-using code into the main body. (Tampermonkey and
  Violentmonkey both put requires inside the same IIFE as the body
  and so don't have this limitation.)
- **The reload-fast-path swap eval can't see GM bindings.** The
  prelude's swap path is `(0,eval)(decision.body + "\n//# sourceURL=" + sourceUrl)`,
  which evaluates at the prelude's function scope, NOT inside the
  main-body wrap function's closure. A storage-granting script
  that took the run-new branch would see `ReferenceError` for
  `GM_setValue` etc. To avoid this silent break,
  `handleCheckPending` in `src/background.ts` declines the swap
  (returns `run` instead of `run-new`) when the wrapper sent
  `needsValues: true` in its check-pending payload — the next
  reload picks up the new body via the ordinary
  `syncRegistrations` path. Non-storage scripts still get the
  fast-path swap.
- **The matcher and async-error attribution lists live in the
  prelude.** The prelude file is byte-identical across every script
  registered; per-script identity is delivered via the config blob.
  This is a feature, not a cost, but it does mean the prelude
  iterates over a small per-script table every time a window error
  fires (filtering by `sourceUrl` + `requireUrls`). At our script
  counts this is irrelevant; just worth noting.

## Mode A — concatenated single blob (not implemented)

This is what SourceMonkey did before the split-out described above.
Sketch (the `WRAPPER_HEAD` / `WRAPPER_TAIL` constants are
hypothetical — Mode B doesn't ship them; an implementation of A
would need to introduce them or splice equivalent fragments out
of the current `WRAPPER_PRELUDE`):

```
js: [
  { code:
      WRAPPER_HEAD                       // IIFE open + matcher + helpers
      + (requires.flatMap(r => `// @require ${r.url}\n${r.source}\n;`).join("\n"))
      + bodyText
      + WRAPPER_TAIL                     // try/catch + IIFE close
      + "\n//# sourceURL=" + sourceUrl
  },
]
```

### Pros

- **Exact closure-scope semantics.** Requires and main body share
  function scope, so `let`/`const` declarations at the top of a
  require are visible to subsequent requires AND to the main body —
  same as Tampermonkey / Violentmonkey.
- **GM_* bindings visible everywhere.** The bindings sit inside the
  IIFE before any require body, so requires can call `GM_*` too.
- **Reload fast-path swap is trivial.** Send `composeRequiredBody`
  (requires + body); the prelude evals it inside the same IIFE
  scope; GM bindings, requires globals, everything is in place.

### Cons

- **Stack traces and line numbers point at the wrong place.** Only
  the last `//# sourceURL=` directive in a script is honored by V8
  for stack frames. So every line in any require or in the main
  body attributes to the SAME source URL, with line numbers offset
  by however many lines of requires were prepended. A bug in line
  50 of the main body shows up as line 1042 of "sourcemonkey://..."
  with no way for the user to map it back. **This is the problem
  that motivated the split.**
- **Per-script payload is bigger.** Each registered script's
  `{code}` blob carries one inlined copy of the wrapper head/tail
  (~5KB minified). With Mode B the prelude lives once per world
  as a separate registration.

### When you might want this

If you discover a real-world script whose requires use bare
top-level `let`/`const` that the main body reads, or that depends
on the wrapper's exact closure-scope semantics, Mode A would
restore the old behavior. We don't expect this — but the wrap
helpers in `src/injector.ts` are mode-neutral, so plugging in a
"concatenate all wraps into one entry" assembler is straightforward.

## Mode C — eval-per-require (TM-style; not implemented)

Sketch (`WRAPPER_HEAD` / `WRAPPER_TAIL` again hypothetical, same
as in Mode A above):

```
js: [
  { code:
      WRAPPER_HEAD                       // IIFE open + matcher + helpers + GM bindings
      + requires.map(r =>
          `(0,eval)(${JSON.stringify(r.source + "\n//# sourceURL=" + r.url)});`
        ).join("\n")
      + `(0,eval)(${JSON.stringify(bodyText + "\n//# sourceURL=" + mainSourceUrl)});`
      + WRAPPER_TAIL
  },
]
```

Or, with direct `eval` instead of `(0,eval)`, so the eval'd code
gets the IIFE's lexical scope (and shares `let`/`const` with
subsequent evals). Tampermonkey does something equivalent — see
the issue tracker links below.

### Pros

- **Real filenames AND pristine line numbers per piece.** V8 honors
  the per-eval `//# sourceURL=` directive, so stack traces point at
  the right URL with the right line.
- **Exact closure-scope semantics (with direct eval).** `var`/`let`/
  `const` at the top of a require become locals of the IIFE,
  visible to subsequent requires and to the main body. Matches
  Mode A's compatibility.
- **GM_* bindings visible to requires.**

### Cons

- **`eval()` is gated by page CSP in MAIN world.** USER_SCRIPT
  world has its own CSP that we set to `'unsafe-eval'` via
  `chrome.userScripts.configureWorld({ csp: ... })`, but MAIN world
  runs under whatever the host page's CSP says. Sites with
  `script-src` that omits `'unsafe-eval'` — and that's a lot of
  them: GitHub, Google, X, Reddit, GitLab, most banking and SaaS
  sites — would refuse the eval at parse time. The userscript
  silently does nothing.
- **No graceful fallback exists.** Once the wrapper has committed
  to eval, the only options on a CSP-blocked page are
  "modify the page's CSP header" (requires the `webRequest` or
  `declarativeNetRequest` permission, asks the user to allow it,
  and weakens site security globally) or "tell the user to disable
  CSP for that site." Tampermonkey ships the former under
  *Advanced settings → "Modify existing content security policy
  (CSP) headers" → Remove entirely*; it's a known long-running
  pain point — see TM issues
  [#593](https://github.com/Tampermonkey/tampermonkey/issues/593),
  [#871](https://github.com/Tampermonkey/tampermonkey/issues/871),
  [#881](https://github.com/Tampermonkey/tampermonkey/issues/881),
  [#1024](https://github.com/Tampermonkey/tampermonkey/issues/1024),
  [#1984](https://github.com/Tampermonkey/tampermonkey/issues/1984).
- **Devtools sources tree shows eval'd scripts under a synthetic
  parent.** A real `{code}` or `{file}` entry shows up as its own
  top-level source; eval'd code shows up nested under a "(VM:N)"
  pseudo-source. Less clean for breakpoint workflows.

### When you might want this

As an **opt-in compatibility mode** for individual scripts that
need exact closure-scope semantics AND don't care about CSP
strictness (because their target site doesn't enforce strict CSP).
The wrap helpers in `src/injector.ts` are designed so a
per-script "use eval mode" flag could be honored by a different
assembler — `wrapRequireEntry` and `wrapMainBodyEntry` produce
strings that can be concatenated with `(0,eval)(JSON.stringify(...))`
around them.

We don't expect to need this in practice — Mode B's tradeoffs are
narrow, and a script that needs the eval semantics can probably be
rewritten to assign its globals explicitly.

## Why we picked Mode B

The choice came down to two questions:

1. **Whose user code does the choice impact?** Mode A and C have
   the right answer for require-side `let`/`const` and for require
   GM-API access. Mode B has the right answer for everyone using a
   library that already attaches to `window`/`globalThis` — which
   is virtually every real-world library (UMD, jQuery, lodash, all
   of them).
2. **What does the choice break, and how silently?** Mode B's
   compatibility surface (top-level `let`/`const` in a require)
   produces a `ReferenceError` at the call site — loud and easy
   to fix. Mode C's compatibility surface (page CSP blocks `eval`)
   produces a silent no-op on a meaningful chunk of the modern web,
   with no actionable error pointing the user at a workaround.

Mode B's compromise is the smaller, louder one — easier for users
to discover and easier to write a workaround for in their own
script.
