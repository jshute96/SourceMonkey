# Injection modes

How SourceMonkey arranges a userscript's code into the `js[]` array
it hands to `chrome.userScripts.register`. Mode A is what ships; Mode B
shipped previously and was replaced; Mode C was never built.

For the lifecycle, world, and matcher pieces of injection that don't
depend on the choice of mode, see [injection.md](injection.md).

## TL;DR

- **Mode A — concatenated user program (current).** Every `@require`
  is concatenated ahead of the script's own body into a single
  `{code}` entry, alongside the per-script config blob and the inlined
  prelude. One entry means one lexical scope, so a library's top-level
  `const`/`let`/`class` is simply visible to the body — the same thing
  TM/VM get by concatenating into one IIFE. Line numbers shift; an
  inline source map puts them back. No `eval`.
- **Mode B — separate entries (previously shipped; replaced).** Each
  `@require` and the main body were their own `{code}` entries.
  Pristine line numbers and a real devtools file per require — but
  separate entries are separate V8 scripts with separate top-level
  scopes, so `const`/`let`/`class` didn't cross, and recovering them
  meant statically analysing library collection. See
  [Why Mode B was replaced](#why-mode-b-was-replaced).
- **Mode C — eval-per-require (not implemented).** One `{code}` entry,
  but inside it the wrapper `eval`s each require and the main body
  separately with a per-piece `//# sourceURL=`. Exact closure
  semantics AND correct stack traces — but `eval()` runs subject to
  page CSP in MAIN world, so MAIN-world scripts silently break on
  any site that omits `'unsafe-eval'` (GitHub, Google, X, Reddit, …).

## Mode A — concatenated user program (current)

The shape of `js[]` for one script registration:

```
js: [
  { code: <config blob> },   // pushes onto self.__smCfgQueue, or
                             // calls self.__smPrelude.init directly
  { code: <prelude>     },   // WRAPPER_PRELUDE + page-wide sourceURL
  { code: <combined>    },   // requires + body, in one __smRun wrap
  { code: <seal>        },   // parse-failure sentinel; own script
]
```

The combined entry:

```
self.__smRun("<id>",function(__smE){<preamble><GM bindings><GM prelude>return(()=>{
// @require https://cdn.example.com/lib.js
<lib.js line 1>
...
;
<body line 1>
...
})();});
//# sourceURL=sourcemonkey://SourceMonkey/<folder>/<name>.user.js
//# sourceMappingURL=data:application/json;charset=utf-8;base64,…
```

- The config blob and prelude stay separate — see
  [Why inline the prelude](#why-inline-the-prelude-not-register-once-per-page).
- A `;` on its own line between segments defeats any hazard from
  **ASI** (Automatic Semicolon Insertion — JS's rule for supplying
  semicolons the author omitted at certain line breaks). ASI does
  *not* fire when the next line can continue the previous statement,
  so a library ending in an expression followed by a body starting
  with `(`, `[`, `` ` ``, `+`, `-` or `/` would parse as one
  statement: `foo()` then `(function(){…})()` becomes a call of
  `foo()`'s return value. Concatenation creates seams the original
  authors never had to think about, so we insert the semicolon rather
  than trust each file to be terminated.
- The source map is emitted only when the script has `@require`s.
  Without them nothing shifts, and the entry is byte-for-byte what
  Mode B produced.

### Pros

- **Exact lexical semantics.** Requires and body share one scope, so
  top-level `let`/`const`/`class` in a library is visible to later
  requires and to the body. This is what TM/VM do, so scripts written
  against them behave the same here.
- **Nothing has to guess.** No parsing, no name analysis, no
  forwarding protocol. The question Mode B kept getting wrong stops
  existing.
- **`@require` code runs inside the `@run-at` gate** with the body,
  rather than firing early in Chrome's `document_start` injection
  burst.
- **Requires see the GM prelude.** Because they run inside the wrap
  function, a library's top-level `GM_setValue` reads a live storage
  cache — under Mode B it hit an uninitialized one.
- **One GM binding block per script** instead of one per require. The
  block bakes in the full `GM_info` JSON literal, so Mode B's
  duplication ran to tens of KB for a verbose header with several
  requires.
- **The reload fast-path swap gets simpler.** `composeRequiredBody`
  is now the same concatenation the registration uses, rather than a
  parallel arrangement that existed only for the swap.
- **No `eval`.** `chrome.userScripts` injection bypasses page CSP.

### Cons / caveats

- **Line numbers shift; both views have to undo it.**
  - Devtools applies the inline source map. Verified in Chrome: the
    Sources tree shows one virtual file per require alongside the
    `.user.js`, console stack traces cite the original files and line
    numbers, and clicking a frame navigates to the right line in the
    right virtual file.
  - V8 does **not** map `err.stack` *strings*, and those are what
    reach our own Log tab. The viewer therefore applies the same
    layout itself — `remapStackRef` over the segments
    `composeSource` produces — so a logged frame names the file the
    code was written in. sm-dev's printed stacks get the same
    rewrite. See
    [script-log.md](script-log.md#stack-refs-are-source-mapped-first).
  - The registered path and the reload-swap path produce the same
    layout, so the viewer maps a hot-swapped script the same way as a
    registered one.
- **The map costs ~1.6× the collection size, so the entry runs ~2.6×.**
  Measured: one 90 KB require → 104 KB of code + 167 KB of map; four
  of them → ~1 MB in one script's `js[]`. `sourcesContent` has to be
  embedded because `sourcemonkey://` URLs aren't fetchable by
  devtools, and base64 adds ~33% on top.
  - Deliberately uncapped. The binding constraint is whether
    `chrome.userScripts.register()` accepts the payload, and that
    already fails loudly: `registerWithFallback` drops to per-script
    registration on rejection, and the offender's row reads REJECTED
    with Chrome's reason (see
    [injection.md](injection.md#rejected-registrations)).
  - It does not touch our `chrome.storage.local` quota — the map is
    generated at registration time from sources already stored. It
    does land in Chrome's own persisted registration store, which
    `syncRegistrations` rewrites on every service-worker startup.
  - Partly offset by shipping the GM bindings once per script instead
    of once per require.
- **A require and the body can now collide.** Two top-level `const x`
  declarations in one scope is a `SyntaxError` that stops the script
  from running. Under Mode B they never met. This is TM/VM behavior —
  compatibility, not a regression — but it is a real behavior change.
  - The wrap's own names (`GM_info`, granted `GM_*`, `unsafeWindow`,
    `__sm*`) are not in that set: the user program runs in a scope
    nested inside the wrap's, so it shadows them. See
    [injection.md](injection.md#the-user-program-scope).
- **A throwing require aborts the whole script.** Mode B's per-require
  `try`/`catch` let the body run anyway. TM/VM abort; so do we now.
- **A *malformed* require takes the whole entry down at parse time**,
  before `__smRun` is ever reached. That would be completely silent,
  so a trailing sentinel entry (`wrapSealEntry`, js[3]) — its own
  script, so it still parses — reports the failure to the Log tab and
  the badge.
- **Require top-level `var` / `function` no longer become globals.**
  They're locals of the user program's scope. Matches TM/VM; differs
  from Mode B, where each require was its own top-level script.

### Why inline the prelude (not register once per page)

Each script ships its own ~12KB copy of `WRAPPER_PRELUDE` in its
`js[]` array. That sounds wasteful — wouldn't a single page-wide
registration be cleaner? It would, but it doesn't work:

- Within ONE `chrome.userScripts.register` entry's `js[]`, Chrome
  runs the entries in array order. The prelude (`js[1]`) is
  guaranteed to install `self.__smRun` / `__smSealed` before the
  combined entry (`js[2]`) and the sentinel (`js[3]`) call them.
- BETWEEN separate `register` calls, the userScripts API gives no
  ordering guarantee. A separately-registered prelude could run
  AFTER a per-script's combined entry, which would synchronously
  throw `TypeError: self.__smRun is not a function` and prevent the
  body from running. We hit this in testing.
- The config blob has a queue-or-init pattern that DOES tolerate
  the prelude running later. The combined entry doesn't — it calls
  the helper immediately. Wrapping that in a defensive
  `if (self.__smRun) {...}` would silently skip the body on a race
  instead of throwing, which is arguably worse.

So we inline, accept the ~12KB × N duplication, and use the page-
wide `sourcemonkey://SourceMonkey/__prelude.js` sourceURL on every
inclusion so devtools' Sources tree groups them into a single
visible entry (V8 dedups script entries by URL in the tree).

## Mode B — separate entries (previously shipped)

The arrangement Mode A replaced:

```
js: [
  { code: <config blob>    },
  { code: <prelude>        },
  { code: <require 1 wrap> },   // for each @require, in order
  { code: <require 2 wrap> },
  ...
  { code: <main body wrap> },
]
```

Each entry was its own V8 script sharing only `globalThis`. Per-script
state lived on `self.__smPrelude.scripts[scriptId]`; helpers
(`self.__smActive`, `self.__smRun`, `self.__smErr`) were installed
once per world by the first prelude run.

### What it bought

- **Real filenames in stack traces**, with no source map. Each
  `@require` was its own entry with a synthetic
  `//# sourceURL=sourcemonkey://SourceMonkey/<folder>/<host>/<path>`,
  so devtools showed it as its own file under the owning script's
  folder.
- **Pristine line numbers** for the main body — line N landed at
  physical line N, because the declaration preamble sat on the same
  physical line as body line 1.
- **No `eval`**, same as Mode A.

Mode A keeps the first two via the source map, at the cost of payload
and of `Error.stack` strings.

### Why Mode B was replaced

Separate entries are separate top-level scopes:

- `var` and `function` at a require's top level landed on
  `globalThis`, so UMD-style libraries (jQuery, lodash, virtually
  anything bundled) worked fine — which is why the tradeoff looked
  narrow at the time. (Mode A scopes them to the wrap function
  instead, as TM/VM do.)
- `let` / `const` / `class` are script-scoped, and simply never
  reached the main body.

The trigger was a real script:

- [Greasy Fork Enhance](https://greasyfork.org/scripts/467078)
  `@require`s [PRO-2684/GM_config](https://github.com/PRO-2684/GM_config).
- That library is minified, ships no linter directive, and exposes
  its entire API as one top-level `class GM_config`.
- Result: `ReferenceError: GM_config is not defined`.

**The fixes we tried, in order.** Each worked; each also revealed the
next problem. The sequence is the argument against the whole approach:

1. **Forward names listed in a JSHint `/* exported X, Y */`
   directive.** Emit `Object.assign(scope, {X, Y})` at the end of the
   require entry, destructure it back out at the top of the main body.
   Works for well-linted libraries (utilsjs.js and friends).
   *Doesn't help a minified library, which has no directive.*
2. **Stop dropping every `GM_`-prefixed name.** The name filter
   existed to avoid redeclaring the wrap's own `const GM_setValue`,
   but it was matching on the prefix, so `GM_config` — an ordinary
   third-party library that merely shares it — was discarded too.
   Narrowed to the names actually emitted.
3. **Infer top-level declarations when there's no directive.** A
   hand-rolled lexer scanning for `class`/`const`/`let` at brace depth
   0. Line anchoring was useless (minified libraries are one physical
   line), so it needed real brace tracking, which needed string,
   comment, template, and regex-vs-division handling.
4. **Absorb wrong guesses.** Inference produces false positives —
   `window.lib = class lib {}` looks like a top-level declaration.
   So: per-name `try{}catch{}` on the producer side, and a
   `"X" in scope ? scope.X : self.X` global fallback on the consumer
   side, so a bad guess couldn't shadow a real `window.X`.
5. **Don't collide with the body's own declarations.** The forwarded
   `var X` shares the body's function scope, so a body declaring
   `const X` was a `SyntaxError` — the script never ran. That needed
   a *second* scan, of the main body, in a "greedy" mode with the
   opposite risk profile: over-reporting costs one un-bridged name,
   under-reporting kills the script.
6. **Fix what the greedy scan missed.** Comma declarator lists
   (`const a = 1, b = 2` found only `a`). Destructuring patterns.
   Top-level `function` declarations, which the bridge silently
   overwrote. Identifiers the wrap *dereferences* rather than
   declares — a library `const self = this` made the wrap's own
   `self.__smPrelude.send` throw.
7. **Stop the lexer eating the file.** `if(a)/re/.test(b)` reads as an
   unterminated regex literal, swallowing everything after it — and a
   declaration the greedy scan never sees is the fatal case. Bounded
   the scan and rewound. Same for nested template substitutions
   containing a literal brace.
8. **Bound the output.** Inference is uncapped where a curated
   directive isn't; a 1 MB require with top-level declarations yielded
   ~21,000 names, which would have put hundreds of KB on the body's
   physical line 1.

At that point the bridge was ~250 lines of lexer plus two scans with
inverted risk profiles, and each round of review found another shape
that broke it. Two ways out were considered:

- **Bundle a real JS parser** (acorn: 57 KB gzipped, SW-only, ~10–16 ms
  on realistic inputs, cacheable against the existing `contentHash`).
  Spiked, and it answered every case correctly — including two the
  heuristic got wrong in opposite directions. But it makes the inputs
  exact while keeping all the machinery, and adds a dependency.
- **Lazy runtime forwarding** — `with` + a Proxy `has` trap to
  intercept unresolved identifiers, and a direct `eval` inside the
  require entry to read its lexical scope. Both verified to work. But
  `eval` is CSP-gated (dead in MAIN world, per Mode C below), `with`
  is a `SyntaxError` in strict mode and silently neutralizes a body's
  own `"use strict"`, and it deoptimizes every identifier lookup in
  the body forever. All three costs are paid *to avoid concatenating*.

Concatenation removes the machinery instead of feeding it. See
[requires.md](requires.md) for what `@require` does today.

## Mode C — eval-per-require (TM-style; not implemented)

Sketch (`WRAPPER_HEAD` / `WRAPPER_TAIL` are hypothetical — no mode
ships them):

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

- **Real filenames AND pristine line numbers per piece**, with no
  source map. V8 honors the per-eval `//# sourceURL=` directive, so
  stack traces point at the right URL with the right line — including
  inside `err.stack` strings, which Mode A's source map cannot fix at
  the collection. (Mode A instead maps those strings on the way into the
  Log tab, which covers our own views but not a script that reads its
  own `err.stack`.)
- **Exact closure-scope semantics (with direct eval).** Same
  compatibility as Mode A.
- **GM_\* bindings visible to requires.**

### Cons

- **`eval()` is gated by page CSP in MAIN world.** USER_SCRIPT
  world has its own CSP that we set to allow `'unsafe-eval'` via
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
  parent.** A real `{code}` entry shows up as its own top-level
  source; eval'd code shows up nested under a "(VM:N)"
  pseudo-collection. Less clean for breakpoint workflows.

### When you might want this

As an **opt-in per-script compatibility mode**:

- Only worth it for scripts whose target sites don't enforce strict
  CSP, and where raw `err.stack` fidelity matters enough to pay for it.
- Mode A already covers the scope semantics, and the Log tab now maps
  stack refs itself, so there is no remaining draw for our own views.
- What is left is third-party code that reads `err.stack` and expects
  original coordinates — a script that ships its own error reporter,
  say. That reads the raw string, which we don't rewrite.

## Why we picked Mode A

The decision turned on which failure the user has to live with:

1. **What does each mode get wrong about user code?** Mode A and C
   have exact scope semantics — a script that works in TM works here.
   Mode B was right only for libraries that attach to
   `window`/`globalThis`, and needed increasingly elaborate static
   analysis for the rest.
2. **What does the mode break, and how silently?** Mode C's failure
   is page CSP blocking `eval`: a silent no-op on a large chunk of
   the modern web, with no actionable error. Mode A's failure is a
   line number in a log string pointing at the concatenated file —
   visible, and recovered by applying the map we already generate —
   which the Log tab now does.
3. **How much machinery does it need?** Mode A needs a source map
   generator. Mode B needed a JS-parsing bridge that kept being
   wrong in new ways. Being unable to answer "what does this source
   declare?" is not a problem worth having when the alternative is
   not needing to ask.
